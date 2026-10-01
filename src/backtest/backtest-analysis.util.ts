import type { MetricsSummary } from '../reports/metrics.util';

/**
 * Pure analyses over stored backtest runs (no I/O): baseline-vs-variant window by window, and the
 * Probability of Backtest Overfitting over several variants. Both only read out-of-sample
 * walk-forward windows — the numbers the research doc says decisions must rest on.
 */

/** Below this many trades on a side, a difference between runs is "inconclusive". */
export const MIN_TRADES_PER_SIDE = 30;

export interface StoredWindow {
  from: string;
  to: string;
  summary: MetricsSummary;
  tradeCount: number;
  /** Balance at the start of the window (runs saved before it existed don't have it). */
  startBalance?: number;
  /** totalPnl ÷ startBalance. */
  returnPct?: number;
}

export interface RunForAnalysis {
  runId: string;
  strategy: string;
  symbols: string[];
  timeframe: string;
  from: Date | string;
  to: Date | string;
  engineVersion?: number;
  params: Record<string, unknown>;
  summary: MetricsSummary;
  walkForwardWindows?: StoredWindow[];
}

export interface WindowSide {
  tradeCount: number;
  winCount: number;
  lossCount: number;
  totalPnl: number;
  returnPct: number;
  /** Backend convention: 0 when there are no losses (see winCount/lossCount for "∞"). */
  profitFactor: number;
  expectancy: number;
  avgReturnPct: number;
}

export interface WindowComparison {
  from: string;
  to: string;
  baseline: WindowSide;
  variant: WindowSide;
  /** null = not comparable in that metric (a side without trades). Ties count as "not better". */
  variantBetter: { pnl: boolean; profitFactor: boolean | null; expectancy: boolean | null };
}

export interface RunComparison {
  baselineRunId: string;
  variantRunId: string;
  /** Same symbols, timeframe, period and window boundaries: the window-by-window verdict is valid. */
  comparable: boolean;
  warnings: string[];
  windows: WindowComparison[];
  /** Share of the compared windows in which the variant did better (null without comparable windows). */
  variantWinShare: {
    windows: number;
    pnl: number | null;
    profitFactor: number | null;
    expectancy: number | null;
    /** Profit factor AND expectancy better in the same window: the E2/E5 criterion. */
    profitFactorAndExpectancy: number | null;
  };
  sample: {
    baseline: { LONG: number; SHORT: number };
    variant: { LONG: number; SHORT: number };
    /** Some traded side has fewer than MIN_TRADES_PER_SIDE trades in one of the runs. */
    inconclusive: boolean;
    minTradesPerSide: number;
  };
}

/** Profit factor as a comparable number: no losses and some wins = ∞; no trades = null. */
function comparablePf(s: WindowSide): number | null {
  if (s.tradeCount === 0) return null;
  if (s.lossCount === 0) return s.winCount > 0 ? Infinity : 0;
  return s.profitFactor;
}

function windowSide(w: StoredWindow, fallbackBalance: number | undefined): WindowSide {
  const s = w.summary;
  const base = w.startBalance ?? fallbackBalance;
  return {
    tradeCount: w.tradeCount,
    winCount: s.winCount,
    lossCount: s.lossCount,
    totalPnl: s.totalPnl,
    returnPct: w.returnPct ?? (base ? s.totalPnl / base : 0),
    profitFactor: s.profitFactor,
    expectancy: s.expectancy,
    avgReturnPct: s.avgReturnPct ?? 0,
  };
}

const iso = (d: Date | string) => new Date(d).toISOString();
const windowKey = (w: { from: string; to: string }) => `${iso(w.from)}|${iso(w.to)}`;
const initialBalanceOf = (run: RunForAnalysis) =>
  typeof run.params.initialBalance === 'number' ? run.params.initialBalance : undefined;

function sideCounts(run: RunForAnalysis): { LONG: number; SHORT: number } {
  const s = run.summary;
  if (s.bySide) return { LONG: s.bySide.LONG.tradeCount, SHORT: s.bySide.SHORT.tradeCount };
  return { LONG: s.longCount ?? s.tradeCount, SHORT: s.shortCount ?? 0 };
}

function share(flags: Array<boolean | null>): number | null {
  const known = flags.filter((f): f is boolean => f !== null);
  return known.length ? known.filter(Boolean).length / known.length : null;
}

export function compareRuns(baseline: RunForAnalysis, variant: RunForAnalysis): RunComparison {
  const warnings: string[] = [];
  const sameSymbols = [...baseline.symbols].sort().join(',') === [...variant.symbols].sort().join(',');
  const samePeriod = iso(baseline.from) === iso(variant.from) && iso(baseline.to) === iso(variant.to);
  if (baseline.strategy !== variant.strategy) warnings.push('Estratégias diferentes.');
  if (!sameSymbols) warnings.push('Símbolos diferentes: o resultado mistura o efeito da mudança com o dos ativos.');
  if (baseline.timeframe !== variant.timeframe) warnings.push('Timeframes diferentes.');
  if (!samePeriod) warnings.push('Períodos diferentes: compare o mesmo intervalo de datas.');
  if (initialBalanceOf(baseline) !== initialBalanceOf(variant)) {
    warnings.push('Saldos iniciais diferentes: PnL e expectância em USDT não são comparáveis, use o retorno %.');
  }
  if ((baseline.engineVersion ?? 1) !== (variant.engineVersion ?? 1)) {
    warnings.push('Execuções de versões diferentes do motor de backtest (ex.: antes do preenchimento de stop com gap). Rode as duas de novo.');
  }

  const baseWindows = baseline.walkForwardWindows ?? [];
  const variantByKey = new Map((variant.walkForwardWindows ?? []).map((w) => [windowKey(w), w]));
  if (!baseWindows.length || !variant.walkForwardWindows?.length) {
    warnings.push('Uma das execuções não tem walk-forward: rode as duas com o mesmo tamanho de janela.');
  }

  const windows: WindowComparison[] = [];
  for (const bw of baseWindows) {
    const vw = variantByKey.get(windowKey(bw));
    if (!vw) continue;
    const b = windowSide(bw, initialBalanceOf(baseline));
    const v = windowSide(vw, initialBalanceOf(variant));
    const bPf = comparablePf(b);
    const vPf = comparablePf(v);
    windows.push({
      from: iso(bw.from),
      to: iso(bw.to),
      baseline: b,
      variant: v,
      variantBetter: {
        pnl: v.returnPct > b.returnPct,
        profitFactor: bPf === null || vPf === null ? null : vPf > bPf,
        expectancy: b.tradeCount && v.tradeCount ? v.avgReturnPct > b.avgReturnPct : null,
      },
    });
  }
  const windowsMatch =
    baseWindows.length > 0 && windows.length === baseWindows.length && windows.length === (variant.walkForwardWindows?.length ?? 0);
  if (baseWindows.length && variant.walkForwardWindows?.length && !windowsMatch) {
    warnings.push('As janelas de walk-forward não coincidem: use o mesmo período e o mesmo tamanho de janela.');
  }

  const sample = { baseline: sideCounts(baseline), variant: sideCounts(variant) };
  const inconclusive = [sample.baseline, sample.variant].some((c) =>
    (['LONG', 'SHORT'] as const).some((side) => c[side] > 0 && c[side] < MIN_TRADES_PER_SIDE),
  );

  return {
    baselineRunId: baseline.runId,
    variantRunId: variant.runId,
    comparable: sameSymbols && samePeriod && baseline.timeframe === variant.timeframe && windowsMatch,
    warnings,
    windows,
    variantWinShare: {
      windows: windows.length,
      pnl: share(windows.map((w) => w.variantBetter.pnl)),
      profitFactor: share(windows.map((w) => w.variantBetter.profitFactor)),
      expectancy: share(windows.map((w) => w.variantBetter.expectancy)),
      profitFactorAndExpectancy: share(
        windows.map((w) =>
          w.variantBetter.profitFactor === null || w.variantBetter.expectancy === null
            ? null
            : w.variantBetter.profitFactor && w.variantBetter.expectancy,
        ),
      ),
    },
    sample: { ...sample, inconclusive, minTradesPerSide: MIN_TRADES_PER_SIDE },
  };
}

// ---------------------------------------------------------------------------------------------
// Probability of Backtest Overfitting (Bailey, Borwein, López de Prado & Zhu 2015), via CSCV

export const PBO_MAX_BLOCKS = 16;

export interface PboResult {
  runIds: string[];
  /** Walk-forward windows per run, and how many contiguous blocks they were grouped into. */
  windows: number;
  blocks: number;
  combinations: number;
  /**
   * Share of the in-sample/out-of-sample splits in which the variant that was best in-sample
   * landed at or below the median out of sample. ~0 = the in-sample winner keeps winning;
   * 0.5 = picking the best is a coin flip; above 0.5 = picking the best is worse than random.
   */
  pbo: number;
  /** Share of the splits in which the in-sample winner lost money out of sample. */
  probOosLoss: number;
  /** Mean return (sum over its blocks) of the in-sample winner, in and out of sample. */
  meanInSampleReturn: number;
  meanOutOfSampleReturn: number;
  /** Logit of the winner's out-of-sample relative rank, bucketed (λ ≤ 0 = at or below the median). */
  logitHistogram: Array<{ bucket: string; count: number }>;
  /** How often each run was the in-sample winner. */
  selected: Array<{ runId: string; count: number }>;
  /** Some windows had no stored startBalance, so their return was estimated from the initial balance. */
  approximated: boolean;
  warnings: string[];
}

export class PboInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

function* combinations(n: number, k: number, start = 0, acc: number[] = []): Generator<number[]> {
  if (acc.length === k) {
    yield acc;
    return;
  }
  for (let i = start; i <= n - (k - acc.length); i++) yield* combinations(n, k, i + 1, [...acc, i]);
}

/** Splits `length` consecutive items into `blocks` contiguous groups whose sizes differ by at most 1. */
function blockOf(length: number, blocks: number): number[] {
  return Array.from({ length }, (_, i) => Math.floor((i * blocks) / length));
}

export function probabilityOfBacktestOverfitting(runs: RunForAnalysis[]): PboResult {
  const problems: string[] = [];
  if (runs.length < 2) problems.push('at least 2 runs are needed');
  const windowed = runs.filter((r) => r.walkForwardWindows?.length);
  if (windowed.length !== runs.length) problems.push('every run needs walk-forward windows');
  if (problems.length) throw new PboInputError(problems);

  const reference = runs[0].walkForwardWindows!.map(windowKey);
  if (runs.some((r) => r.walkForwardWindows!.map(windowKey).join(';') !== reference.join(';'))) {
    throw new PboInputError(['all runs must have the same walk-forward windows (same period and window size)']);
  }
  const windows = reference.length;
  const blocks = Math.min(PBO_MAX_BLOCKS, windows - (windows % 2));
  if (blocks < 4) throw new PboInputError(['at least 4 walk-forward windows are needed (more is better)']);

  let approximated = false;
  const assign = blockOf(windows, blocks);
  // perf[run][block] = summed window returns in that block.
  const perf = runs.map((r) => {
    const row = Array.from({ length: blocks }, () => 0);
    r.walkForwardWindows!.forEach((w, i) => {
      if (w.returnPct === undefined) approximated = true;
      row[assign[i]] += windowSide(w, initialBalanceOf(r)).returnPct;
    });
    return row;
  });

  const n = runs.length;
  const logits: number[] = [];
  const selected = Array.from({ length: n }, () => 0);
  let losses = 0;
  let isSum = 0;
  let oosSum = 0;
  let combos = 0;
  for (const inSample of combinations(blocks, blocks / 2)) {
    const isSet = new Set(inSample);
    const isPerf = perf.map((row) => row.reduce((acc, v, b) => (isSet.has(b) ? acc + v : acc), 0));
    const oosPerf = perf.map((row) => row.reduce((acc, v, b) => (isSet.has(b) ? acc : acc + v), 0));
    let best = 0;
    for (let i = 1; i < n; i++) if (isPerf[i] > isPerf[best]) best = i;
    selected[best]++;
    const below = oosPerf.filter((v, i) => i !== best && v < oosPerf[best]).length;
    const ties = oosPerf.filter((v, i) => i !== best && v === oosPerf[best]).length;
    const rank = below + ties / 2 + 1; // 1 = worst, n = best
    const omega = rank / (n + 1);
    logits.push(Math.log(omega / (1 - omega)));
    if (oosPerf[best] < 0) losses++;
    isSum += isPerf[best];
    oosSum += oosPerf[best];
    combos++;
  }

  const edges = [-2, -1, 0, 1, 2];
  const labels = [`< ${edges[0]}`, ...edges.slice(0, -1).map((e, i) => `${e} a ${edges[i + 1]}`), `>= ${edges[edges.length - 1]}`];
  const counts = labels.map(() => 0);
  for (const l of logits) {
    let idx = edges.findIndex((e) => l < e);
    if (idx === -1) idx = labels.length - 1;
    counts[idx]++;
  }

  const warnings: string[] = [];
  if (n < 5) warnings.push('Com poucas variantes o PBO é grosseiro; ele fica mais informativo com 5 ou mais.');
  if (new Set(runs.map((r) => r.engineVersion ?? 1)).size > 1) {
    warnings.push('Execuções de versões diferentes do motor de backtest: rode todas de novo antes de concluir.');
  }
  if (windows > blocks) warnings.push(`${windows} janelas agrupadas em ${blocks} blocos contíguos para limitar as combinações.`);

  return {
    runIds: runs.map((r) => r.runId),
    windows,
    blocks,
    combinations: combos,
    pbo: logits.filter((l) => l <= 0).length / combos,
    probOosLoss: losses / combos,
    meanInSampleReturn: isSum / combos,
    meanOutOfSampleReturn: oosSum / combos,
    logitHistogram: labels.map((bucket, i) => ({ bucket, count: counts[i] })),
    selected: runs.map((r, i) => ({ runId: r.runId, count: selected[i] })),
    approximated,
    warnings,
  };
}
