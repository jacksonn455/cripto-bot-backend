import { Candle } from '../exchange/types/candle.type';

export interface StopTargetLevels {
  stopLoss: number;
  takeProfit?: number;
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
  const hitStop = candle.low <= levels.stopLoss;
  const hitTarget = levels.takeProfit !== undefined && candle.high >= levels.takeProfit;
  if (hitStop) return { exitPrice: levels.stopLoss, reason: 'SL' };
  if (hitTarget) return { exitPrice: levels.takeProfit!, reason: 'TP' };
  return null;
}
