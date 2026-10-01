import { Inject, Injectable, Logger } from '@nestjs/common';
import { binanceConfig, tradingConfig } from '../../config/configuration';
import { ExchangeGateway, ExchangeGatewayKind } from '../exchange-gateway.interface';
import { Balance } from '../types/balance.type';
import { Candle, GetCandlesParams } from '../types/candle.type';
import { OrderResult, PlaceOrderParams } from '../types/order.type';
import { SymbolFilters } from '../types/symbol-filters.type';
import { BinanceRestClient } from '../binance/binance-rest.client';
import type { PaperBalanceStore } from './paper-balance.store';

/**
 * Simulated trading: never sends real orders. Uses real public market data
 * (candles/filters) from Binance production (read-only, no keys) and simulates fills, so they
 * reflect real market prices. Balances are persisted through `store` (Mongo `paper_balances`),
 * so a restart keeps the wallet consistent with the open trades stored in Mongo; without a store
 * (tests) they live in memory only.
 * Order fill simulation here is intentionally simple (instant fill at last close for
 * MARKET orders); the backtest/execution phases will refine slippage and resting orders.
 * Shorts are simulated as a plain negative base balance (sell first, buy back later): no borrow
 * interest, funding or liquidation is modeled, so paper shorts look slightly better than real ones.
 */
@Injectable()
export class PaperExchangeGateway implements ExchangeGateway {
  readonly kind: ExchangeGatewayKind = 'PAPER';
  readonly supportsShortSelling = true;

  private readonly logger = new Logger(PaperExchangeGateway.name);
  private readonly marketDataClient: BinanceRestClient;
  private readonly balances = new Map<string, Balance>();
  private readonly openOrders: OrderResult[] = [];
  private orderSeq = 1;
  private loaded?: Promise<void>;

  constructor(
    @Inject(binanceConfig.KEY)
    binance: ReturnType<typeof binanceConfig>,
    @Inject(tradingConfig.KEY)
    trading: ReturnType<typeof tradingConfig>,
    private readonly store?: PaperBalanceStore,
  ) {
    // No API key/secret needed: only public endpoints are used for market data.
    this.marketDataClient = new BinanceRestClient(
      '',
      '',
      binance.marketDataBaseUrl,
      binance.recvWindow,
      binance.httpTimeoutMs,
    );
    this.balances.set(trading.paperInitialBalanceAsset, {
      asset: trading.paperInitialBalanceAsset,
      free: trading.paperInitialBalanceAmount,
      locked: 0,
    });
    this.logger.log(
      `Paper gateway seeded with ${trading.paperInitialBalanceAmount} ${trading.paperInitialBalanceAsset}`,
    );
  }

  async getBalances(): Promise<Balance[]> {
    await this.ensureLoaded();
    return Array.from(this.balances.values());
  }

  async getBalance(asset: string): Promise<Balance | undefined> {
    await this.ensureLoaded();
    return this.balances.get(asset);
  }

  /** Loads the persisted wallet once (lazily); the first run persists the seeded balance. */
  private ensureLoaded(): Promise<void> {
    if (!this.store) return Promise.resolve();
    this.loaded ??= (async () => {
      try {
        const saved = await this.store!.load();
        if (saved) {
          this.balances.clear();
          for (const b of saved) this.balances.set(b.asset, b);
          this.logger.log(`Paper wallet restored: ${saved.map((b) => `${b.free} ${b.asset}`).join(', ')}`);
        } else {
          await this.store!.save(Array.from(this.balances.values()));
        }
      } catch (err) {
        this.loaded = undefined; // retry on next use
        throw err;
      }
    })();
    return this.loaded;
  }

  async getCandles(params: GetCandlesParams): Promise<Candle[]> {
    return this.marketDataClient.getCandles(params);
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    return this.marketDataClient.getSymbolFilters(symbol);
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    if (params.type !== 'MARKET') {
      const order = this.buildOrder(params, 'NEW', 0, params.price ?? 0);
      this.openOrders.push(order);
      return order;
    }

    const [latest] = await this.marketDataClient.getCandles({
      symbol: params.symbol,
      interval: '1m',
      limit: 1,
    });
    const fillPrice = latest?.close ?? params.price ?? 0;
    await this.applyFill(params, fillPrice);
    return this.buildOrder(params, 'FILLED', params.quantity, fillPrice);
  }

  async cancelOrder(symbol: string, orderIdOrClientOrderId: string): Promise<void> {
    const index = this.openOrders.findIndex(
      (o) =>
        o.symbol === symbol &&
        (o.orderId === orderIdOrClientOrderId ||
          o.clientOrderId === orderIdOrClientOrderId),
    );
    if (index >= 0) {
      this.openOrders.splice(index, 1);
    }
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    return symbol
      ? this.openOrders.filter((o) => o.symbol === symbol)
      : [...this.openOrders];
  }

  async getOrder(symbol: string, orderIdOrClientOrderId: string): Promise<OrderResult | undefined> {
    // Paper fills instantly and doesn't retain history — only resting (never-filled) orders exist.
    return this.openOrders.find(
      (o) =>
        o.symbol === symbol &&
        (o.orderId === orderIdOrClientOrderId || o.clientOrderId === orderIdOrClientOrderId),
    );
  }

  private async applyFill(params: PlaceOrderParams, price: number): Promise<void> {
    await this.ensureLoaded();
    const filters = await this.getSymbolFilters(params.symbol);
    const cost = params.quantity * price;
    if (params.side === 'BUY') {
      this.adjustBalance(filters.quoteAsset, -cost);
      this.adjustBalance(filters.baseAsset, params.quantity);
    } else {
      this.adjustBalance(filters.baseAsset, -params.quantity);
      this.adjustBalance(filters.quoteAsset, cost);
    }
    await this.store?.save(Array.from(this.balances.values()));
  }

  private adjustBalance(asset: string, deltaFree: number): void {
    const current = this.balances.get(asset) ?? { asset, free: 0, locked: 0 };
    this.balances.set(asset, { ...current, free: current.free + deltaFree });
  }

  private buildOrder(
    params: PlaceOrderParams,
    status: OrderResult['status'],
    executedQty: number,
    price: number,
  ): OrderResult {
    return {
      symbol: params.symbol,
      orderId: String(this.orderSeq++),
      clientOrderId: params.newClientOrderId,
      side: params.side,
      type: params.type,
      status,
      price,
      stopPrice: params.stopPrice,
      origQty: params.quantity,
      executedQty,
      createdAt: Date.now(),
    };
  }
}
