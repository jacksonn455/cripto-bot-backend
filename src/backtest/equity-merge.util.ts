import type { EquityPoint } from './backtest.types';

/**
 * Sums per-symbol equity curves into one portfolio curve (fixed allocation per symbol, no shared
 * margin). At every timestamp that appears in any curve, each symbol contributes its latest point
 * so far — or its starting capital before its first point.
 */
export function mergeEquityCurves(curves: EquityPoint[][], startingCapital: number[]): EquityPoint[] {
  if (curves.length === 1) return curves[0];
  const timestamps = [...new Set(curves.flatMap((c) => c.map((p) => p.timestamp)))].sort((a, b) => a - b);
  const cursor = curves.map(() => -1);
  return timestamps.map((timestamp) => {
    let balance = 0;
    let equity = 0;
    let openPositions = 0;
    curves.forEach((curve, i) => {
      while (cursor[i] + 1 < curve.length && curve[cursor[i] + 1].timestamp <= timestamp) cursor[i]++;
      const p = cursor[i] >= 0 ? curve[cursor[i]] : null;
      balance += p ? p.balance : startingCapital[i];
      equity += p ? p.equity : startingCapital[i];
      openPositions += p ? p.openPositions : 0;
    });
    return { timestamp, balance, equity, openPositions };
  });
}
