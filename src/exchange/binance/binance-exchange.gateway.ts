import { Inject, Injectable, Logger } from '@nestjs/common';
import { binanceConfig } from '../../config/configuration';
import { ExchangeGateway, ExchangeGatewayKind } from '../exchange-gateway.interface';
import { Balance } from '../types/balance.type';
import { Candle, GetCandlesParams } from '../types/candle.type';
import { OrderResult, PlaceOrderParams } from '../types/order.type';
import { SymbolFilters } from '../types/symbol-filters.type';
import { BinanceRestClient } from './binance-rest.client';

/**
 * Talks to real Binance (spot). Only reachable when TRADING_MODE=LIVE and
 * LIVE_TRADING_CONFIRMED=true — enforced at config validation, not here.
 * BINANCE_BASE_URL points at testnet by default, so "LIVE" usually still means testnet.
 */
@Injectable()
export class BinanceExchangeGateway implements ExchangeGateway {
  readonly kind: ExchangeGatewayKind = 'BINANCE';
  /**
   * Spot API: a SELL needs the asset in the wallet, there is no borrowing. Shorting for real would
   * need Binance Margin (borrow + repay) or USD-M Futures — a different gateway, not this one.
   */
  readonly supportsShortSelling = false;

  private readonly logger = new Logger(BinanceExchangeGateway.name);
  private readonly client: BinanceRestClient;

  constructor(
    @Inject(binanceConfig.KEY)
    private readonly config: ReturnType<typeof binanceConfig>,
  ) {
    this.client = new BinanceRestClient(
      this.config.apiKey,
      this.config.apiSecret,
      this.config.baseUrl,
      this.config.recvWindow,
    );
    this.logger.log(`Binance gateway configured against ${this.config.baseUrl}`);
  }

  async getBalances(): Promise<Balance[]> {
    return this.client.getAccountBalances();
  }

  async getBalance(asset: string): Promise<Balance | undefined> {
    const balances = await this.getBalances();
    return balances.find((b) => b.asset === asset);
  }

  async getCandles(params: GetCandlesParams): Promise<Candle[]> {
    return this.client.getCandles(params);
  }

  async getSymbolFilters(symbol: string): Promise<SymbolFilters> {
    return this.client.getSymbolFilters(symbol);
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    this.logger.log(
      `Placing ${params.side} ${params.type} order for ${params.quantity} ${params.symbol}`,
    );
    return this.client.placeOrder(params);
  }

  async cancelOrder(symbol: string, orderIdOrClientOrderId: string): Promise<void> {
    await this.client.cancelOrder(symbol, orderIdOrClientOrderId);
  }

  async getOpenOrders(symbol?: string): Promise<OrderResult[]> {
    return this.client.getOpenOrders(symbol);
  }

  async getOrder(symbol: string, orderIdOrClientOrderId: string): Promise<OrderResult | undefined> {
    return this.client.getOrder(symbol, orderIdOrClientOrderId);
  }

  /** User Data Stream plumbing — Binance-specific, not part of the generic ExchangeGateway. */
  createListenKey(): Promise<string> {
    return this.client.createListenKey();
  }

  renewListenKey(listenKey: string): Promise<void> {
    return this.client.renewListenKey(listenKey);
  }

  closeListenKey(listenKey: string): Promise<void> {
    return this.client.closeListenKey(listenKey);
  }

  get wsBaseUrl(): string {
    return this.config.wsBaseUrl;
  }
}
