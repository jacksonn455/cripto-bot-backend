import { Candle } from '../exchange/types/candle.type';
import type { TradeSide } from '../trades/schemas/trade.schema';

export interface StopTargetLevels {
  stopLoss: number;
  takeProfit?: number;
  /** Defaults to LONG (stop below, target above). SHORT mirrors it: stop above, target below. */
  side?: TradeSide;
}

/**
 * Conservative intra-candle fill rule: if a candle's range touches both the stop and the
 * target, assume the stop was hit first. Shared by the backtest engine and the paper
 * execution poller (which has no real exchange stop order to rely on).
 */
export function checkIntraCandleExit(
  levels: StopTargetLevels,
  candle: Pick<Candle, 'high' | 'low'>,
): { exitPrice: number; reason: 'SL' | 'TP' } | null {
  const isShort = levels.side === 'SHORT';
  const hitStop = isShort ? candle.high >= levels.stopLoss : candle.low <= levels.stopLoss;
  const hitTarget =
    levels.takeProfit !== undefined &&
    (isShort ? candle.low <= levels.takeProfit : candle.high >= levels.takeProfit);
  if (hitStop) return { exitPrice: levels.stopLoss, reason: 'SL' };
  if (hitTarget) return { exitPrice: levels.takeProfit!, reason: 'TP' };
  return null;
}
