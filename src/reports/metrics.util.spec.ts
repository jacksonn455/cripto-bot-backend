import { computeMetrics } from './metrics.util';

describe('computeMetrics', () => {
  // Hand-calculated: see chat/PR notes for the full derivation.
  const trades = [
    { pnl: 100, pnlPct: 5, entryTime: 0, exitTime: 1000, exitReason: 'TP' },
    { pnl: -50, pnlPct: -2.5, entryTime: 1000, exitTime: 2500, exitReason: 'SL' },
    { pnl: -30, pnlPct: -1.5, entryTime: 2500, exitTime: 3000, exitReason: 'SL' },
    { pnl: 80, pnlPct: 4, entryTime: 3000, exitTime: 4500, exitReason: 'TRAILING' },
  ];

  const metrics = computeMetrics(trades, 1000);

  it('computes basic win/loss stats', () => {
    expect(metrics.tradeCount).toBe(4);
    expect(metrics.winCount).toBe(2);
    expect(metrics.lossCount).toBe(2);
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.totalPnl).toBe(100);
    expect(metrics.avgWin).toBe(90);
    expect(metrics.avgLoss).toBe(-40);
  });

  it('computes payoff ratio, profit factor and expectancy', () => {
    expect(metrics.payoffRatio).toBeCloseTo(2.25);
    expect(metrics.profitFactor).toBeCloseTo(2.25);
    expect(metrics.expectancy).toBe(25);
    // (5 − 2.5 − 1.5 + 4) / 4
    expect(metrics.avgReturnPct).toBeCloseTo(1.25);
  });

  it('computes max drawdown from the equity curve', () => {
    // peak 1100 after trade 1, trough 1020 after trade 3 -> drawdown 80
    expect(metrics.maxDrawdown).toBeCloseTo(80);
    expect(metrics.maxDrawdownPct).toBeCloseTo(80 / 1100, 5);
  });

  it('computes Sharpe and Sortino from per-trade pnlPct', () => {
    expect(metrics.sharpe).toBeCloseTo(0.3292, 3);
    expect(metrics.sortino).toBeCloseTo(0.3802, 3);
  });

  it('computes the max losing streak', () => {
    expect(metrics.maxLosingStreak).toBe(2);
  });

  it('computes average hold time', () => {
    expect(metrics.avgHoldTimeMs).toBe(1125);
  });

  it('breaks down trades by exit reason', () => {
    expect(metrics.exitReasonBreakdown).toEqual({ TP: 1, SL: 2, TRAILING: 1 });
  });

  it('buckets trades into a PnL% histogram', () => {
    expect(metrics.pnlHistogram).toEqual([
      { bucket: '< -5%', count: 0 },
      { bucket: '-5% a -2%', count: 1 },
      { bucket: '-2% a 0%', count: 1 },
      { bucket: '0% a 2%', count: 0 },
      { bucket: '2% a 5%', count: 1 },
      { bucket: '>= 5%', count: 1 },
    ]);
  });

  it('returns all-zero metrics for an empty trade list', () => {
    const empty = computeMetrics([], 1000);
    expect(empty.tradeCount).toBe(0);
    expect(empty.winRate).toBe(0);
    expect(empty.profitFactor).toBe(0);
    expect(empty.maxDrawdown).toBe(0);
  });
});
