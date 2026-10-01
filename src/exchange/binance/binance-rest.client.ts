import { Spot } from '@binance/connector';
import { Balance } from '../types/balance.type';
import { Candle, GetCandlesParams } from '../types/candle.type';
import { OrderResult, OrderStatus, PlaceOrderParams } from '../types/order.type';
import { SymbolFilters } from '../types/symbol-filters.type';

interface RawExchangeInfoFilter {
  filterType: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minNotional?: string;
  notional?: string;
}

interface RawExchangeInfoSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  filters: RawExchangeInfoFilter[];
}

interface RawExchangeInfo {
  symbols: RawExchangeInfoSymbol[];
}

interface RawAccountBalance {
  asset: string;
  free: string;
  locked: string;
}

interface RawAccountInfo {
  balances: RawAccountBalance[];
}

interface RawOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  side: string;
  type: string;
  status: string;
  price: string;
  stopPrice?: string;
  origQty: string;
  executedQty: string;
  transactTime?: number;
  time?: number;
}

/** Extra attempts for idempotent reads (klines, exchangeInfo, ping): 0.5 s, then 1.5 s. */
const READ_RETRY = 2;
const RETRY_BASE_DELAY_MS = 500;
/** Fail-fast network errors worth retrying. A timeout is NOT retried: it already cost BINANCE_HTTP_TIMEOUT_MS. */
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/**
 * Transient = no HTTP response because of a network error, or an HTTP 5xx. 4xx (incl. 403/451 geo
 * blocks, 418/429 rate limits) is not: retrying can't fix it and would only add load.
 */
export function isTransient(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { response?: { status?: number }; code?: string };
  if (e.response) return (e.response.status ?? 0) >= 500;
  return e.code !== undefined && TRANSIENT_NETWORK_CODES.has(e.code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin typed wrapper around the untyped @binance/connector Spot client.
 * This is the only place in the codebase that talks to the raw Binance response shapes.
 */
export class BinanceRestClient {
  private readonly client: Spot;

  constructor(
    apiKey: string,
    apiSecret: string,
    baseUrl: string,
    recvWindow: number,
    timeoutMs = 15_000,
  ) {
    this.client = new Spot(apiKey, apiSecret, {
      baseURL: baseUrl,
      recvWindow,
      // The SDK default is 0 (wait forever): a hung connection would freeze the execution loop.
      timeout: timeoutMs,
    });
  }

  async ping(): Promise<void> {
    await this.call(() => this.client.ping(), READ_RETRY);
  }

  async getCandles(params: GetCandlesParams): Promise<Candle[]> {
    const { symbol, interval, limit, startTime, endTime } = params;
    const data = await this.call<unknown[][]>(() =>
      this.client.klines(symbol, interval, { limit, startTime, endTime }),
      READ_RETRY,
    );
    const now = Date.now();
    return data.map((row) => {
      const r = row as [
        number,
        string,
        string,
        string,
        string,
        string,
        number,
        string,
        number,
        string,
        string,
        string,
      ];
      const closeTime = r[6];
      return {
        symbol,
        interval,
        openTime: r[0],
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5]),
        closeTime,
        quoteVolume: parseFloat(r[7]),
        trades: r[8],
        isClosed: closeTime < now,
      };
    });
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    const info = await this.call<RawExchangeInfo>(() =>
      this.client.exchangeInfo({ symbol }),
      READ_RETRY,
    );
    const symbolInfo = info.symbols[0];
    if (!symbolInfo) {
      throw new Error(`Symbol not found on exchange: ${symbol}`);
    }

    const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
    const priceFilter = symbolInfo.filters.find(
      (f) => f.filterType === 'PRICE_FILTER',
    );
    const notional = symbolInfo.filters.find(
      (f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL',
    );

    return {
      symbol: symbolInfo.symbol,
      baseAsset: symbolInfo.baseAsset,
      quoteAsset: symbolInfo.quoteAsset,
      status: symbolInfo.status,
      minQty: parseFloat(lotSize?.minQty ?? '0'),
      maxQty: parseFloat(lotSize?.maxQty ?? '0'),
      stepSize: parseFloat(lotSize?.stepSize ?? '0'),
      minPrice: parseFloat(priceFilter?.minPrice ?? '0'),
      maxPrice: parseFloat(priceFilter?.maxPrice ?? '0'),
      tickSize: parseFloat(priceFilter?.tickSize ?? '0'),
      minNotional: parseFloat(
        notional?.minNotional ?? notional?.notional ?? '0',
      ),
    };
  }

  async getAccountBalances(): Promise<Balance[]> {
    const info = await this.call<RawAccountInfo>(() => this.client.account());
    return info.balances.map((b) => ({
      asset: b.asset,
      free: parseFloat(b.free),
      locked: parseFloat(b.locked),
    }));
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const raw = await this.call<RawOrder>(() =>
      this.client.newOrder(params.symbol, params.side, params.type, {
        quantity: params.quantity,
        price: params.price,
        stopPrice: params.stopPrice,
        newClientOrderId: params.newClientOrderId,
        newOrderRespType: 'FULL',
        timeInForce:
          params.type === 'LIMIT' || params.type === 'STOP_LOSS_LIMIT'
            ? 'GTC'
            : undefined,
      }),
    );
    return this.mapOrder(raw);
  }

  async cancelOrder(symbol: string, orderIdOrClientOrderId: string): Promise<void> {
    const isNumeric = /^\d+$/.test(orderIdOrClientOrderId);
    await this.call(() =>
      this.client.cancelOrder(symbol, {
        orderId: isNumeric ? Number(orderIdOrClientOrderId) : undefined,
        origClientOrderId: isNumeric ? undefined : orderIdOrClientOrderId,
      }),
    );
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    const raw = await this.call<RawOrder[]>(() =>
      this.client.openOrders({ symbol }),
    );
    return raw.map((o) => this.mapOrder(o));
  }

  async getOrder(symbol: string, orderIdOrClientOrderId: string): Promise<OrderResult | undefined> {
    const isNumeric = /^\d+$/.test(orderIdOrClientOrderId);
    try {
      const raw = await this.call<RawOrder>(() =>
        this.client.getOrder(symbol, {
          orderId: isNumeric ? Number(orderIdOrClientOrderId) : undefined,
          origClientOrderId: isNumeric ? undefined : orderIdOrClientOrderId,
        }),
      );
      return this.mapOrder(raw);
    } catch {
      return undefined;
    }
  }

  async createListenKey(): Promise<string> {
    const data = await this.call<{ listenKey: string }>(() => this.client.createListenKey());
    return data.listenKey;
  }

  async renewListenKey(listenKey: string): Promise<void> {
    await this.call(() => this.client.renewListenKey(listenKey));
  }

  async closeListenKey(listenKey: string): Promise<void> {
    await this.call(() => this.client.closeListenKey(listenKey));
  }

  /**
   * Unwraps the SDK's axios response and turns failures into a compact, loggable Error.
   * `retries` > 0 only for idempotent public reads: a transient network error or 5xx is retried
   * with backoff; orders, cancels and account calls are never retried here.
   */
  private async call<T>(fn: () => Promise<{ data: unknown }>, retries = 0): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fn();
        return response.data as T;
      } catch (err) {
        if (attempt >= retries || !isTransient(err)) throw this.toCleanError(err);
        await sleep(RETRY_BASE_DELAY_MS * 3 ** attempt);
      }
    }
  }

  private toCleanError(err: unknown): Error {
    if (err && typeof err === 'object' && 'response' in err) {
      const axiosErr = err as {
        response?: { status?: number; data?: unknown };
        message?: string;
      };
      const status = axiosErr.response?.status;
      const data = axiosErr.response?.data;
      return new Error(
        `Binance API error${status ? ` (HTTP ${status})` : ''}: ${
          data ? JSON.stringify(data) : axiosErr.message
        }`,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private mapOrder(raw: RawOrder): OrderResult {
    return {
      symbol: raw.symbol,
      orderId: String(raw.orderId),
      clientOrderId: raw.clientOrderId,
      side: raw.side as OrderResult['side'],
      type: raw.type as OrderResult['type'],
      status: raw.status as OrderStatus,
      price: parseFloat(raw.price),
      stopPrice: raw.stopPrice ? parseFloat(raw.stopPrice) : undefined,
      origQty: parseFloat(raw.origQty),
      executedQty: parseFloat(raw.executedQty),
      createdAt: raw.transactTime ?? raw.time ?? Date.now(),
    };
  }
}
