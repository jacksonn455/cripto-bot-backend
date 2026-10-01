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
    expect(empty.rStats).toBeUndefined();
  });

  it('has no R stats when the trades carry no stop/qty (older data)', () => {
    expect(metrics.rStats).toBeUndefined();
  });

  describe('R multiples (pnl ÷ initial risk)', () => {
    // Entry 100, stop 90, qty 1 → 10 of risk per trade.
    const rTrades = [30, -10, -12, 5, 20].map((pnl, i) => ({
      pnl,
      pnlPct: pnl,
      entryTime: i * 1000,
      exitTime: i * 1000 + 500,
      entryPrice: 100,
      stopLoss: 90,
      qty: 1,
    }));
    const r = computeMetrics(rTrades, 1000).rStats!;

    it('summarizes the R distribution', () => {
      expect(r.tradeCount).toBe(5);
      expect(r.avgR).toBeCloseTo(0.66);
      expect(r.medianR).toBeCloseTo(0.5);
      expect(r.bestR).toBeCloseTo(3);
      expect(r.worstR).toBeCloseTo(-1.2);
      expect(r.tradesAtLeast3R).toBe(1);
      expect(r.rHistogram).toEqual([
        { bucket: '< -1R', count: 1 },
        { bucket: '-1R a 0R', count: 1 },
        { bucket: '0R a 1R', count: 1 },
        { bucket: '1R a 2R', count: 0 },
        { bucket: '2R a 3R', count: 1 },
        { bucket: '>= 3R', count: 1 },
      ]);
    });

    it('measures how much of the gross profit the best 10% of trades made', () => {
      // Best trade (30) of a gross profit of 55 (30 + 5 + 20).
      expect(r.topDecilePnlShare).toBeCloseTo(30 / 55);
    });

    it('computes the implied Kelly fraction: W − (1 − W) ÷ (avg win R ÷ avg loss R)', () => {
      // W = 0.6, avg win 1.8333R, avg loss 1.1R → 0.6 − 0.4 ÷ 1.6667 = 0.36
      expect(r.kellyFraction).toBeCloseTo(0.36);
    });
  });
});
