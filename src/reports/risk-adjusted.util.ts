import { EULER_MASCHERONI, kurtosis, mean, normalCdf, normalInv, skewness, stdDev } from './stats.util';

/** Crypto trades 24/7: a year is 365 daily returns (not the 252 of stock markets). */
export const DAYS_PER_YEAR = 365;

/**
 * Performance from the DAILY equity curve (open positions marked to market), annualized for a
 * 24/7 market. Unlike the per-trade Sharpe in MetricsSummary, these are comparable across runs
 * with different trade frequencies, and are the inputs of the Probabilistic / Deflated Sharpe.
 * Fractions everywhere (0.12 = 12%).
 */
export interface RiskAdjustedMetrics {
  /** Daily returns behind the numbers (UTC days). */
  days: number;
  totalReturn: number;
  /** Compound annual growth rate. */
  cagr: number;
  annualVolatility: number;
  /** Mean daily return ÷ its standard deviation, NOT annualized: the unit PSR/DSR work in. */
  sharpeDaily: number;
  sharpeAnnualized: number;
  /** Downside deviation against 0 (only losing days count as risk). */
  sortinoAnnualized: number;
  /** Deepest peak-to-trough fall of the daily equity, open positions included. */
  maxDrawdown: number;
  /** cagr ÷ maxDrawdown (0 without a drawdown). */
  calmar: number;
  skewness: number;
  /** Not excess: a normal distribution has 3. Fat tails push it up. */
  kurtosis: number;
  /**
   * Probability that the true Sharpe is above 0, given the sample length, skewness and kurtosis
   * (Bailey & López de Prado 2012). Does NOT account for how many variations were tried — that is
   * the Deflated Sharpe (see deflatedSharpe).
   */
  probabilisticSharpe: number;
}

/** Last equity of each UTC day, starting from the initial balance. */
export function dailyEquity(curve: Array<{ timestamp: number | Date; equity: number }>, initialBalance: number): number[] {
  const byDay = new Map<string, number>();
  const sorted = [...curve].sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));
  for (const p of sorted) byDay.set(new Date(toMs(p.timestamp)).toISOString().slice(0, 10), p.equity);
  return [initialBalance, ...byDay.values()];
}

/** null when there are fewer than 3 daily returns (nothing meaningful to say). */
export function computeRiskAdjusted(
  curve: Array<{ timestamp: number | Date; equity: number }>,
  initialBalance: number,
): RiskAdjustedMetrics | null {
  if (!(initialBalance > 0)) return null;
  const equity = dailyEquity(curve, initialBalance);
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) returns.push(equity[i - 1] > 0 ? equity[i] / equity[i - 1] - 1 : 0);
  if (returns.length < 3) return null;

  const m = mean(returns);
  const sd = stdDev(returns, m);
  const downside = Math.sqrt(mean(returns.map((r) => Math.min(r, 0) ** 2)));
  const sharpeDaily = sd > 0 ? m / sd : 0;
  const final = equity[equity.length - 1];
  const totalReturn = final / initialBalance - 1;
  const years = returns.length / DAYS_PER_YEAR;
  const cagr = final > 0 ? (final / initialBalance) ** (1 / years) - 1 : -1;

  let peak = equity[0];
  let maxDrawdown = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - e) / peak);
  }

  const skew = skewness(returns);
  const kurt = kurtosis(returns);
  return {
    days: returns.length,
    totalReturn,
    cagr,
    annualVolatility: sd * Math.sqrt(DAYS_PER_YEAR),
    sharpeDaily,
    sharpeAnnualized: sharpeDaily * Math.sqrt(DAYS_PER_YEAR),
    sortinoAnnualized: downside > 0 ? (m / downside) * Math.sqrt(DAYS_PER_YEAR) : 0,
    maxDrawdown,
    calmar: maxDrawdown > 0 ? cagr / maxDrawdown : 0,
    skewness: skew,
    kurtosis: kurt,
    probabilisticSharpe: probabilisticSharpe(sharpeDaily, 0, returns.length, skew, kurt),
  };
}

/**
 * PSR(SR*) = Φ( (SR − SR*) · √(T − 1) / √(1 − γ3·SR + (γ4 − 1)/4 · SR²) ), with SR and SR* in the
 * same (non-annualized) frequency as the T returns.
 */
export function probabilisticSharpe(sr: number, benchmark: number, observations: number, skew: number, kurt: number): number {
  if (observations < 2) return 0;
  const denom = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  if (!(denom > 0)) return sr > benchmark ? 1 : 0;
  return normalCdf(((sr - benchmark) * Math.sqrt(observations - 1)) / Math.sqrt(denom));
}

/**
 * The Sharpe the best of `trials` independent tries would reach by luck alone, given the variance
 * of their Sharpes (Bailey & López de Prado 2014): √V · ((1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))).
 */
export function expectedMaxSharpe(trials: number, sharpeVariance: number): number {
  if (trials <= 1 || !(sharpeVariance > 0)) return 0;
  const g = EULER_MASCHERONI;
  return Math.sqrt(sharpeVariance) * ((1 - g) * normalInv(1 - 1 / trials) + g * normalInv(1 - 1 / (trials * Math.E)));
}

/** DSR: the PSR against the luck benchmark of `trials` tries instead of against 0. */
export function deflatedSharpe(m: Pick<RiskAdjustedMetrics, 'sharpeDaily' | 'days' | 'skewness' | 'kurtosis'>, trials: number, sharpeVariance: number) {
  const benchmark = expectedMaxSharpe(trials, sharpeVariance);
  return {
    /** Daily units, like sharpeDaily. */
    expectedMaxSharpeDaily: benchmark,
    deflatedSharpe: probabilisticSharpe(m.sharpeDaily, benchmark, m.days, m.skewness, m.kurtosis),
  };
}

/**
 * Harvey & Liu (2015) haircut with the Bonferroni adjustment: the Sharpe's p-value is multiplied by
 * the number of tries, then turned back into a Sharpe. The strictest of their three adjustments.
 * Returns the adjusted annualized Sharpe and the haircut (0.4 = 40% of the Sharpe discounted).
 */
export function harveyLiuHaircut(sharpeAnnualized: number, days: number, trials: number) {
  const years = days / DAYS_PER_YEAR;
  if (trials <= 1) return { haircutSharpe: sharpeAnnualized, haircut: 0 };
  if (years <= 0 || sharpeAnnualized === 0) return { haircutSharpe: 0, haircut: sharpeAnnualized === 0 ? 0 : 1 };
  const t = Math.abs(sharpeAnnualized) * Math.sqrt(years);
  const p = 2 * (1 - normalCdf(t));
  const adjusted = Math.min(1, p * Math.max(1, trials));
  const tAdjusted = adjusted >= 1 ? 0 : normalInv(1 - adjusted / 2);
  const haircutSharpe = (Math.sign(sharpeAnnualized) * tAdjusted) / Math.sqrt(years);
  return { haircutSharpe, haircut: 1 - haircutSharpe / sharpeAnnualized };
}

function toMs(value: number | Date): number {
  return value instanceof Date ? value.getTime() : value;
}
