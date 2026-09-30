import type { Trade, TradeExitReason, TradeMode, TradeSide } from './schemas/trade.schema';

/**
 * Payloads of the `trade.opened` / `trade.closed` domain events. Emitted by execution,
 * reconciliation and the kill switch; consumed by reports (cache invalidation), the SSE stream
 * and notifications. Keys from the original payloads (symbol, side, qty, entryPrice, stopLoss,
 * pnl, reason, mode) are kept as-is so existing dashboard consumers keep working.
 */
export interface TradeOpenedEvent {
  tradeId: string;
  symbol: string;
  side: TradeSide;
  mode: TradeMode;
  strategy: string;
  timeframe?: string;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number;
  /** ISO timestamp. */
  entryTime: string;
  /** Why the strategy entered. */
  signalReason?: string;
}

export interface TradeClosedEvent {
  tradeId: string;
  symbol: string;
  side: TradeSide;
  mode: TradeMode;
  strategy: string;
  timeframe?: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  fees: number;
  /** Exit reason (TP/SL/TRAILING/SIGNAL/MANUAL/KILL_SWITCH). */
  reason: TradeExitReason;
  /** Free-text detail, e.g. the strategy's exit explanation. */
  reasonDetail?: string;
  /** ISO timestamps. */
  entryTime: string;
  exitTime: string;
}

export const TRADE_OPENED = 'trade.opened';
export const TRADE_CLOSED = 'trade.closed';

type TradeLike = Pick<
  Trade,
  'symbol' | 'side' | 'mode' | 'strategy' | 'timeframe' | 'qty' | 'entryPrice' | 'stopLoss' | 'takeProfit' | 'entryTime' | 'entryReason'
> & { _id: unknown };

export function buildTradeOpenedEvent(trade: TradeLike): TradeOpenedEvent {
  return {
    tradeId: String(trade._id),
    symbol: trade.symbol,
    side: trade.side,
    mode: trade.mode,
    strategy: trade.strategy,
    timeframe: trade.timeframe,
    qty: trade.qty,
    entryPrice: trade.entryPrice,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    entryTime: toIso(trade.entryTime),
    signalReason: trade.entryReason,
  };
}

export function buildTradeClosedEvent(
  trade: TradeLike,
  close: { exitPrice: number; exitTime: Date; pnl: number; pnlPct: number; fees: number; exitReason: TradeExitReason },
  reasonDetail?: string,
): TradeClosedEvent {
  return {
    tradeId: String(trade._id),
    symbol: trade.symbol,
    side: trade.side,
    mode: trade.mode,
    strategy: trade.strategy,
    timeframe: trade.timeframe,
    qty: trade.qty,
    entryPrice: trade.entryPrice,
    exitPrice: close.exitPrice,
    pnl: close.pnl,
    pnlPct: close.pnlPct,
    fees: close.fees,
    reason: close.exitReason,
    reasonDetail,
    entryTime: toIso(trade.entryTime),
    exitTime: close.exitTime.toISOString(),
  };
}

function toIso(value: Date | string | undefined): string {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
