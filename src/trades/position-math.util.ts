import type { OrderSide } from '../exchange/types/order.type';
import type { SignalAction } from '../strategy/strategy.interface';
import type { TradeSide } from './schemas/trade.schema';

/**
 * Direction-aware position math, shared by execution, reconciliation, kill switch and backtests
 * so LONG and SHORT are always settled by the same formulas.
 *
 * LONG profits when price rises: pnl = (exit - entry) * qty.
 * SHORT profits when price falls: pnl = (entry - exit) * qty.
 * pnlPct is the return on the entry notional, positive = profit, for both sides.
 */
export function direction(side: TradeSide): 1 | -1 {
  return side === 'SHORT' ? -1 : 1;
}

/** LONG opens with BUY; SHORT opens with SELL (sell first, buy back later). */
export function entryOrderSide(side: TradeSide): OrderSide {
  return side === 'SHORT' ? 'SELL' : 'BUY';
}

/** The order that flattens a position: LONG closes with SELL, SHORT closes with BUY. */
export function exitOrderSide(side: TradeSide): OrderSide {
  return side === 'SHORT' ? 'BUY' : 'SELL';
}

export function sideFromSignal(action: SignalAction): TradeSide | null {
  if (action === 'ENTER_LONG') return 'LONG';
  if (action === 'ENTER_SHORT') return 'SHORT';
  return null;
}

/** Realized result of a round trip; `fees` (quote currency) are subtracted from pnl, not from pnlPct. */
export function computePnl(
  side: TradeSide,
  entryPrice: number,
  exitPrice: number,
  qty: number,
  fees = 0,
): { pnl: number; pnlPct: number } {
  const dir = direction(side);
  const pnl = (exitPrice - entryPrice) * qty * dir - fees;
  const pnlPct = entryPrice !== 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 * dir : 0;
  return { pnl, pnlPct };
}

/** Mark-to-market pnl of an open position at `markPrice` (no fees). */
export function unrealizedPnl(side: TradeSide, entryPrice: number, markPrice: number, qty: number): number {
  return (markPrice - entryPrice) * qty * direction(side);
}

/**
 * Signed value an open position adds to the account: a long holds `qty` of the asset (+qty*price);
 * a short owes it back (-qty*price), while its sale proceeds already sit in the quote balance.
 */
export function positionValue(side: TradeSide, qty: number, markPrice: number): number {
  return qty * markPrice * direction(side);
}

/** Whether a stop sits on the losing side of the entry (below for LONG, above for SHORT). */
export function isStopOnLosingSide(side: TradeSide, entryPrice: number, stopLoss: number): boolean {
  return side === 'SHORT' ? stopLoss > entryPrice : stopLoss < entryPrice;
}

/** Whether a take profit sits on the winning side of the entry (above for LONG, below for SHORT). */
export function isTargetOnWinningSide(side: TradeSide, entryPrice: number, takeProfit: number): boolean {
  return side === 'SHORT' ? takeProfit < entryPrice : takeProfit > entryPrice;
}
