/**
 * Pure metrics computation, shared by the backtest engine (summary of a run) and
 * ReportsModule (summary over persisted trades). Sharpe/Sortino here are computed
 * per-trade (using pnlPct as the "return" series), not resampled to daily returns.
 * The daily, annualized versions (plus Calmar and the probabilistic/deflated Sharpe) come from
 * the equity curve in risk-adjusted.util.ts.
 */
export interface ClosedTradeMetricsInput {
  pnl: number;
  pnlPct: number;
  entryTime: Date | number;
  exitTime: Date | number;
  exitReason?: string;
  /** LONG/SHORT; trades without it count as LONG (everything before shorts existed). */
  side?: string;
  /** Quote-currency fees already included in pnl (for the cost breakdown only). */
  fees?: number;
  /** With stopLoss and qty: the planned (initial) risk, so the result can be read in R multiples. */
  entryPrice?: number;
  /** The initial stop (the one the position was sized on). */
  stopLoss?: number;
  qty?: number;
}

/**
 * Results in multiples of the risk taken (R = pnl ÷ (|entry − stop| × qty)). Trend following
 * lives on a few large winners: if most of the PnL comes from the best 10% of trades, a fixed
 * take profit would cut exactly those.
 */
export interface RMultipleStats {
  /** Trades with a usable initial risk (entry, stop and qty known). */
  tradeCount: number;
  avgR: number;
  medianR: number;
  bestR: number;
  worstR: number;
  /** Trades that made at least 3R. */
  tradesAtLeast3R: number;
  rHistogram: Array<{ bucket: string; count: number }>;
  /** Share of the gross profit made by the best 10% of trades (0–1); null without winning trades. */
  topDecilePnlShare: number | null;
  /**
   * Kelly fraction implied by the R distribution, W − (1 − W) ÷ (avg win R ÷ avg loss R): the risk
   * per trade that would maximize growth IF these numbers were the true edge. Diagnostic only — a
   * backtest overstates the edge, so risking more than ~¼ of it is aggressive. null without wins
   * and losses.
   */
  kellyFraction: number | null;
}

export interface SideMetrics {
  tradeCount: number;
  winCount: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  expectancy: number;
  avgReturnPct: number;
}

export interface MetricsSummary {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  /** lossCount / tradeCount (a zero-pnl trade counts as a loss, as in winRate). */
  lossRate: number;
  totalPnl: number;
  grossProfit: number;
  /** Absolute value of the summed losing trades. */
  grossLoss: number;
  totalFees: number;
  longCount: number;
  shortCount: number;
  /** Same core metrics per direction, so long and short results are never judged blended. */
  bySide: { LONG: SideMetrics; SHORT: SideMetrics };
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
  /** Absent when no trade carries entry/stop/qty (e.g. older data). */
  rStats?: RMultipleStats;
}

const HISTOGRAM_BUCKETS = [-5, -2, 0, 2, 5] as const;
const R_BUCKETS = [-1, 0, 1, 2, 3] as const;

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

  const longs = sorted.filter((t) => t.side !== 'SHORT');
  const shorts = sorted.filter((t) => t.side === 'SHORT');

  return {
    tradeCount,
    winCount,
    lossCount,
    winRate: tradeCount ? winCount / tradeCount : 0,
    lossRate: tradeCount ? lossCount / tradeCount : 0,
    totalPnl,
    grossProfit,
    grossLoss,
    totalFees: sum(sorted.map((t) => t.fees ?? 0)),
    longCount: longs.length,
    shortCount: shorts.length,
    bySide: { LONG: computeSideMetrics(longs), SHORT: computeSideMetrics(shorts) },
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
    rStats: computeRStats(sorted),
  };
}

function computeRStats(trades: ClosedTradeMetricsInput[]): RMultipleStats | undefined {
  const rs: number[] = [];
  for (const t of trades) {
    if (t.entryPrice === undefined || t.stopLoss === undefined || t.qty === undefined) continue;
    const risk = Math.abs(t.entryPrice - t.stopLoss) * t.qty;
    if (risk > 0) rs.push(t.pnl / risk);
  }
  if (rs.length === 0) return undefined;

  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const avgWinR = wins.length ? sum(wins) / wins.length : 0;
  const avgLossR = losses.length ? Math.abs(sum(losses) / losses.length) : 0;
  const winRate = wins.length / rs.length;
  const kellyFraction = wins.length && losses.length && avgLossR > 0 ? winRate - (1 - winRate) / (avgWinR / avgLossR) : null;

  // Gross profit, not net: with a net PnL near zero the share of it explodes and means nothing.
  const grossProfit = sum(trades.filter((t) => t.pnl > 0).map((t) => t.pnl));
  const byPnl = trades.map((t) => t.pnl).sort((a, b) => b - a);
  const top = byPnl.slice(0, Math.max(1, Math.ceil(byPnl.length * 0.1)));

  const labels = [
    `< ${R_BUCKETS[0]}R`,
    ...R_BUCKETS.slice(0, -1).map((b, i) => `${b}R a ${R_BUCKETS[i + 1]}R`),
    `>= ${R_BUCKETS[R_BUCKETS.length - 1]}R`,
  ];
  const counts: number[] = Array.from({ length: labels.length }, () => 0);
  for (const r of rs) {
    let index = R_BUCKETS.findIndex((b) => r < b);
    if (index === -1) index = labels.length - 1;
    counts[index] += 1;
  }

  const sortedR = [...rs].sort((a, b) => a - b);
  const mid = Math.floor(sortedR.length / 2);
  return {
    tradeCount: rs.length,
    avgR: sum(rs) / rs.length,
    medianR: sortedR.length % 2 ? sortedR[mid] : (sortedR[mid - 1] + sortedR[mid]) / 2,
    bestR: sortedR[sortedR.length - 1],
    worstR: sortedR[0],
    tradesAtLeast3R: rs.filter((r) => r >= 3).length,
    rHistogram: labels.map((bucket, i) => ({ bucket, count: counts[i] })),
    topDecilePnlShare: grossProfit > 0 ? Math.max(0, sum(top)) / grossProfit : null,
    kellyFraction,
  };
}

function computeSideMetrics(trades: ClosedTradeMetricsInput[]): SideMetrics {
  const tradeCount = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const grossProfit = sum(wins.map((t) => t.pnl));
  const grossLoss = Math.abs(sum(trades.filter((t) => t.pnl <= 0).map((t) => t.pnl)));
  const totalPnl = sum(trades.map((t) => t.pnl));
  return {
    tradeCount,
    winCount: wins.length,
    winRate: tradeCount ? wins.length / tradeCount : 0,
    totalPnl,
    profitFactor: grossLoss !== 0 ? grossProfit / grossLoss : 0,
    expectancy: tradeCount ? totalPnl / tradeCount : 0,
    avgReturnPct: tradeCount ? sum(trades.map((t) => t.pnlPct)) / tradeCount : 0,
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
