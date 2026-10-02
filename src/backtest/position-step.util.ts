import type { Candle } from '../exchange/types/candle.type';
import type { OpenPositionInfo, Signal } from '../strategy/strategy.interface';
import type { TradeExitReason, TradeSide } from '../trades/schemas/trade.schema';
import { checkIntraCandleExit } from './intra-candle-exit.util';

export interface SteppedPosition {
  side: TradeSide;
  /** Fill price (what the strategy is told the position entered at). */
  entryPrice: number;
  /** Current protective stop. */
  stopLoss: number;
  takeProfit?: number;
  entryTime: number;
  /** The stop has moved from the initial one: a stop hit then exits as TRAILING. */
  trailed: boolean;
}

export type PositionStep =
  | { kind: 'EXIT'; price: number; reason: TradeExitReason; gapped: boolean }
  /** Still open; `stopLoss`/`trailed` are the (possibly ratcheted) values to carry on with. */
  | { kind: 'HOLD'; stopLoss: number; trailed: boolean };

/**
 * One closed candle of an open position, exactly as the backtest has always simulated it — shared
 * by BacktestRunner and the candidate shadow outcomes so both use the same exits:
 *  1. stop / target touched inside the candle (stop first, gap fills at the open);
 *  2. otherwise the strategy's exit rules on the close (`evaluate` = strategy.onCandleClosed with
 *     this position; null = no decision);
 *  3. otherwise a since-entry trailing stop may tighten the stop (never loosen it).
 */
export function stepOpenPosition(
  position: SteppedPosition,
  candle: Candle,
  evaluate: (openPosition: OpenPositionInfo) => Signal | null,
): PositionStep {
  const intra = checkIntraCandleExit(position, candle);
  if (intra) {
    const reason = intra.reason === 'SL' && position.trailed ? 'TRAILING' : intra.reason;
    return { kind: 'EXIT', price: intra.exitPrice, reason, gapped: intra.gapped === true };
  }
  const signal = evaluate({
    side: position.side,
    entryPrice: position.entryPrice,
    stopLoss: position.stopLoss,
    entryTime: position.entryTime,
  });
  if (signal?.action === 'EXIT') return { kind: 'EXIT', price: signal.price, reason: 'SIGNAL', gapped: false };
  if (signal?.trailingStop !== undefined) {
    const tighter = position.side === 'SHORT' ? signal.trailingStop < position.stopLoss : signal.trailingStop > position.stopLoss;
    if (tighter) return { kind: 'HOLD', stopLoss: signal.trailingStop, trailed: true };
  }
  return { kind: 'HOLD', stopLoss: position.stopLoss, trailed: position.trailed };
}
