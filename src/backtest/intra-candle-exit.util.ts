import { Candle } from '../exchange/types/candle.type';
import type { TradeSide } from '../trades/schemas/trade.schema';

export interface StopTargetLevels {
  stopLoss: number;
  takeProfit?: number;
  /** Defaults to LONG (stop below, target above). SHORT mirrors it: stop above, target below. */
  side?: TradeSide;
}

export interface IntraCandleExit {
  exitPrice: number;
  reason: 'SL' | 'TP';
  /** The candle opened already past the stop: filled at the open, worse than the stop price. */
  gapped?: boolean;
}

/**
 * Conservative intra-candle fill rule: if a candle's range touches both the stop and the
 * target, assume the stop was hit first. Shared by the backtest engine and the paper
 * execution poller (which has no real exchange stop order to rely on).
 *
 * A stop is a market order once triggered, so when the candle already opens beyond it (a gap,
 * e.g. a short squeeze between candles) the fill is the open, not the stop. The target keeps its
 * own price even on a favorable gap: a limit order never fills better than the conservative case
 * assumed here.
 */
export function checkIntraCandleExit(
  levels: StopTargetLevels,
  candle: Pick<Candle, 'high' | 'low'> & Partial<Pick<Candle, 'open'>>,
): IntraCandleExit | null {
  const isShort = levels.side === 'SHORT';
  const hitStop = isShort ? candle.high >= levels.stopLoss : candle.low <= levels.stopLoss;
  const hitTarget =
    levels.takeProfit !== undefined &&
    (isShort ? candle.low <= levels.takeProfit : candle.high >= levels.takeProfit);
  if (hitStop) {
    const open = candle.open;
    const gapped = open !== undefined && (isShort ? open > levels.stopLoss : open < levels.stopLoss);
    return gapped ? { exitPrice: open, reason: 'SL', gapped: true } : { exitPrice: levels.stopLoss, reason: 'SL' };
  }
  if (hitTarget) return { exitPrice: levels.takeProfit!, reason: 'TP' };
  return null;
}
