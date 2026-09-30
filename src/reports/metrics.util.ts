/**
 * Pure metrics computation, shared by the backtest engine (summary of a run) and
 * ReportsModule (summary over persisted trades). Sharpe/Sortino here are computed
 * per-trade (using pnlPct as the "return" series), not resampled to daily returns —
 * a reasonable simplification for a modest sample of swing trades.
 */
export interface ClosedTradeMetricsInput {
  pnl: number;
  pnlPct: number;
  entryTime: Date | number;
  exitTime: Date | number;
  exitReason?: string;
}

export interface MetricsSummary {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  payoffRatio: number;
  profitFactor: number;
  expectancy: number;
  /**
   * Mean pnlPct per trade (in percent). Unlike expectancy (quote currency), it doesn't depend on
   * position size, so it's the fairer number to compare backtest vs paper vs live.
   */
  avgReturnPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  sharpe: number;
  sortino: number;
  maxLosingStreak: number;
  avgHoldTimeMs: number;
  exitReasonBreakdown: Record<string, number>;
  pnlHistogram: Array<{ bucket: string; count: number }>;
}

const HISTOGRAM_BUCKETS = [-5, -2, 0, 2, 5] as const;

export function computeMetrics(
  trades: ClosedTradeMetricsInput[],
  initialBalance = 0,
): MetricsSummary {
  const sorted = [...trades].sort((a, b) => toMs(a.exitTime) - toMs(b.exitTime));

  const tradeCount = sorted.length;
  const wins = sorted.filter((t) => t.pnl > 0);
  const losses = sorted.filter((t) => t.pnl <= 0);
  const winCount = wins.length;
  const lossCount = losses.length;
  const totalPnl = sum(sorted.map((t) => t.pnl));
  const avgWin = wins.length ? sum(wins.map((t) => t.pnl)) / wins.length : 0;
  const avgLoss = losses.length ? sum(losses.map((t) => t.pnl)) / losses.length : 0;
  const grossProfit = sum(wins.map((t) => t.pnl));
  const grossLoss = Math.abs(sum(losses.map((t) => t.pnl)));

  const returns = sorted.map((t) => t.pnlPct);
  const meanReturn = returns.length ? sum(returns) / returns.length : 0;
  const stdDev = standardDeviation(returns, meanReturn);
  const downsideDev = downsideDeviation(returns, meanReturn);

  const { maxDrawdown, maxDrawdownPct } = computeDrawdown(sorted, initialBalance);

  return {
    tradeCount,
    winCount,
    lossCount,
    winRate: tradeCount ? winCount / tradeCount : 0,
    totalPnl,
    avgWin,
    avgLoss,
    payoffRatio: avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : 0,
    profitFactor: grossLoss !== 0 ? grossProfit / grossLoss : 0,
    expectancy: tradeCount ? totalPnl / tradeCount : 0,
    avgReturnPct: meanReturn,
    maxDrawdown,
    maxDrawdownPct,
    sharpe: stdDev !== 0 ? meanReturn / stdDev : 0,
    sortino: downsideDev !== 0 ? meanReturn / downsideDev : 0,
    maxLosingStreak: computeMaxLosingStreak(sorted),
    avgHoldTimeMs: tradeCount
      ? sum(sorted.map((t) => toMs(t.exitTime) - toMs(t.entryTime))) / tradeCount
      : 0,
    exitReasonBreakdown: computeExitReasonBreakdown(sorted),
    pnlHistogram: computePnlHistogram(sorted),
  };
}

function toMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function standardDeviation(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = sum(values.map((v) => (v - mean) ** 2)) / (values.length - 1);
  return Math.sqrt(variance);
}

function downsideDeviation(values: number[], mean: number): number {
  const downside = values.filter((v) => v < mean).map((v) => (v - mean) ** 2);
  if (downside.length === 0) return 0;
  return Math.sqrt(sum(downside) / downside.length);
}

function computeDrawdown(
  trades: ClosedTradeMetricsInput[],
  initialBalance: number,
): { maxDrawdown: number; maxDrawdownPct: number } {
  let equity = initialBalance;
  let peak = initialBalance;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    equity += trade.pnl;
    peak = Math.max(peak, equity);
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peak !== 0 ? drawdown / peak : 0;
    }
  }

  return { maxDrawdown, maxDrawdownPct };
}

function computeMaxLosingStreak(trades: ClosedTradeMetricsInput[]): number {
  let max = 0;
  let current = 0;
  for (const trade of trades) {
    if (trade.pnl < 0) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function computeExitReasonBreakdown(trades: ClosedTradeMetricsInput[]): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const trade of trades) {
    const key = trade.exitReason ?? 'UNKNOWN';
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  return breakdown;
}

function computePnlHistogram(
  trades: ClosedTradeMetricsInput[],
): Array<{ bucket: string; count: number }> {
  const labels = [
    `< ${HISTOGRAM_BUCKETS[0]}%`,
    ...HISTOGRAM_BUCKETS.slice(0, -1).map((b, i) => `${b}% a ${HISTOGRAM_BUCKETS[i + 1]}%`),
    `>= ${HISTOGRAM_BUCKETS[HISTOGRAM_BUCKETS.length - 1]}%`,
  ];
  const counts: number[] = Array.from({ length: labels.length }, () => 0);

  for (const trade of trades) {
    let index = HISTOGRAM_BUCKETS.findIndex((b) => trade.pnlPct < b);
    if (index === -1) index = labels.length - 1;
    counts[index] += 1;
  }

  return labels.map((bucket, i) => ({ bucket, count: counts[i] }));
}
