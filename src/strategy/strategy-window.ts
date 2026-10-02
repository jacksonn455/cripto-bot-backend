import type { Candle } from '../exchange/types/candle.type';

/** Candles beyond the regime EMA period that every consumer of the strategy sees. */
export const STRATEGY_WINDOW_MARGIN = 10;

/**
 * How many CLOSED candles the strategy sees per evaluation (per timeframe): the single source of
 * truth for the live loop, the backtest and the AI market snapshot. An EMA is seeded with the SMA
 * of its first `period` values, so the same last candle gives a different EMA200 on a 210- vs a
 * 211-candle window: every consumer must cut the window the same way to get the same decision.
 * 210 (EMA200 + 10) is the window the backtests and the V0–V3 research were run with.
 */
export function strategyWindowSize(emaRegime: number): number {
  return emaRegime + STRATEGY_WINDOW_MARGIN;
}

/**
 * The last `size` closed candles, oldest first. Exchanges return the still-forming candle as the
 * last kline (sometimes not), so "fetch N and drop the open one" yields N or N−1 closed candles
 * depending on timing; fetch a few extra and cut here instead.
 */
export function lastClosedCandles(candles: readonly Candle[], size: number): Candle[] {
  const closed = candles.filter((c) => c.isClosed);
  return closed.slice(Math.max(0, closed.length - size));
}
