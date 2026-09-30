import {
  Balance,
  Candle,
  GetCandlesParams,
  OrderResult,
  PlaceOrderParams,
  SymbolFilters,
} from './types';

/** DI token — interfaces have no runtime representation in TS. */
export const EXCHANGE_GATEWAY = Symbol('EXCHANGE_GATEWAY');

export type ExchangeGatewayKind = 'BINANCE' | 'PAPER' | 'BACKTEST';

/**
 * Single seam between strategy/risk/execution and the outside world.
 * Strategies and RiskManager must never talk to Binance directly — only through this.
 */
export interface ExchangeGateway {
  readonly kind: ExchangeGatewayKind;
  /**
   * Whether a SELL may open a position without holding the asset (a short). Spot venues can't
   * borrow, so RiskManager vetoes ENTER_SHORT (SHORT_NOT_SUPPORTED) instead of sending the order.
   */
  readonly supportsShortSelling: boolean;

  getBalances(): Promise<Balance[]>;
  getBalance(asset: string): Promise<Balance | undefined>;

  getCandles(params: GetCandlesParams): Promise<Candle[]>;
  getSymbolFilters(symbol: string): Promise<SymbolFilters>;

  placeOrder(params: PlaceOrderParams): Promise<OrderResult>;
  cancelOrder(symbol: string, orderIdOrClientOrderId: string): Promise<void>;
  getOpenOrders(symbol?: string): Promise<OrderResult[]>;
  getOrder(symbol: string, orderIdOrClientOrderId: string): Promise<OrderResult | undefined>;
}
