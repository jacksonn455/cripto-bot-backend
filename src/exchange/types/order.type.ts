export type OrderSide = 'BUY' | 'SELL';

export type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP_LOSS_LIMIT'
  | 'TAKE_PROFIT_LIMIT'
  | 'OCO';

export type OrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED';

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  /** Deterministic id supplied by the caller (execution module) for idempotency. */
  newClientOrderId: string;
}

export interface OrderResult {
  symbol: string;
  orderId: string;
  clientOrderId: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price: number;
  stopPrice?: number;
  origQty: number;
  executedQty: number;
  createdAt: number;
}
