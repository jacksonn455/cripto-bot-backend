/**
 * Research harness for the pre-registered V0–V3 protocol (docs/ESTRATEGIA-PESQUISA.md, section 5).
 * Pure simulation: real Binance candles (cached on disk), the production BacktestRunner, Strategy and
 * RiskManager, no database. Skipped unless RUN_RESEARCH=1:
 *
 *   RUN_RESEARCH=1 pnpm test -- src/research
 *
 * Writes the full results to docs/research/variants-results.json (or RESEARCH_OUT). Nothing here
 * picks a winner: it computes the criteria exactly as registered and reports pass/fail.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Candle } from '../exchange/types/candle.type';
import { IndicatorsService } from '../indicators/indicators.service';
import { computeMetrics, MetricsSummary } from '../reports/metrics.util';
import { computeRiskAdjusted, deflatedSharpe, RiskAdjustedMetrics } from '../reports/risk-adjusted.util';
import { variance } from '../reports/stats.util';
import { RiskManagerService } from '../risk/risk-manager.service';
import { TrendRegimeStrategy } from '../strategy/trend-regime.strategy';
import { compareRuns, PboResult, probabilityOfBacktestOverfitting, RunForAnalysis, StoredWindow } from '../backtest/backtest-analysis.util';
import { BacktestRunner } from '../backtest/backtest-runner';
import type { SimulatedTrade, SymbolSeries } from '../backtest/backtest.types';

const RUN = process.env.RUN_RESEARCH === '1';
const H = 3_600_000;
const DAY = 86_400_000;

// ---- Protocol (as registered; do not edit after looking at results) -------------------------
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT'];
const PERIODS = {
  DEV: { from: Date.UTC(2023, 0, 1), to: Date.UTC(2024, 11, 31, 23, 59, 59, 999) },
  OOS: { from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 8, 30, 23, 59, 59, 999) },
} as const;
type PeriodKey = keyof typeof PERIODS;
const WINDOW_DAYS = 90;
const MIN_WINDOW_DAYS = 30;
const CANDLE_LOOKBACK = 210; // emaRegime + 10, the live window
const V1_REGIME_LOOKBACK = 1000;
const INITIAL = 10_000;
const COSTS = {
  '1x': { feesPct: 0.001, slippagePct: 0.0005, stopSlippagePct: 0.001, shortBorrowPctPerDay: 0.0003 },
  '2x': { feesPct: 0.002, slippagePct: 0.001, stopSlippagePct: 0.002, shortBorrowPctPerDay: 0.0006 },
} as const;
type CostKey = keyof typeof COSTS;

const BASE_STRATEGY = {
  symbols: SYMBOLS, timeframe: '1h', regimeTimeframe: '4h', emaFast: 20, emaSlow: 50, emaRegime: 200,
  rsiPeriod: 14, rsiMin: 45, rsiMax: 70, atrPeriod: 14, atrStopMultiplier: 2, chandelierLookback: 22, chandelierAtrMultiplier: 3,
};
const RISK = { riskPerTradePct: 0.01, maxOpenPositions: 3, maxExposurePerAssetPct: 0.3, maxTotalExposurePct: 0.6, maxDailyLossPct: 0.03, maxConsecutiveStops: 3, minRiskRewardRatio: 1.5, minVolume24h: 0, maxSpreadPct: 100 };

interface Variant { key: string; params: Record<string, number>; regimeLookback?: number }
const V1_PARAMS = { trailingMode: 1 };
const VARIANTS: Variant[] = [
  { key: 'V0', params: {} },
  { key: 'V1', params: V1_PARAMS, regimeLookback: V1_REGIME_LOOKBACK },
  { key: 'V2', params: { ...V1_PARAMS, rsiMin: 0, rsiMax: 100 }, regimeLookback: V1_REGIME_LOOKBACK },
  { key: 'V3', params: { ...V1_PARAMS, pullbackLookback: 5 }, regimeLookback: V1_REGIME_LOOKBACK },
];
const SIDES = { L: 0, LS: 1 } as const;
type SideKey = keyof typeof SIDES;
const SENSITIVITY: Array<Record<string, number>> = [{ atrStopMultiplier: 1.5 }, { atrStopMultiplier: 2.5 }, { chandelierAtrMultiplier: 2.5 }, { chandelierAtrMultiplier: 3.5 }];
const DSR_TRIALS = VARIANTS.length * 2 + VARIANTS.length * SENSITIVITY.length; // 24

// ---- Data -----------------------------------------------------------------------------------
const CACHE = process.env.RESEARCH_CACHE_DIR ?? join(tmpdir(), 'krypto-research-candles');

async function klines(symbol: string, interval: string, from: number, to: number): Promise<Candle[]> {
  const file = join(CACHE, `${symbol}-${interval}-${from}-${to}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8')) as Candle[];
  const out: Candle[] = [];
  let cursor = from;
  while (cursor < to) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${to}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<[number, string, string, string, string, string, number]>;
    if (!rows.length) break;
    for (const r of rows) {
      out.push({ symbol, interval, openTime: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], closeTime: r[6], quoteVolume: 0, trades: 0, isClosed: r[6] < Date.now() });
    }
    cursor = rows[rows.length - 1][0] + 1;
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify(out));
  return out;
}

const data = new Map<string, { h1: Candle[]; h4: Candle[] }>();
async function loadData() {
  const from1h = PERIODS.DEV.from - (CANDLE_LOOKBACK + 10) * H;
  const from4h = PERIODS.DEV.from - (V1_REGIME_LOOKBACK + 10) * 4 * H;
  const to = PERIODS.OOS.to;
  for (const s of SYMBOLS) data.set(s, { h1: await klines(s, '1h', from1h, to), h4: await klines(s, '4h', from4h, to) });
}

// ---- Simulation -----------------------------------------------------------------------------
function windowsOf(p: { from: number; to: number }) {
  const out: Array<{ from: number; to: number }> = [];
  for (let c = p.from; c < p.to; c += WINDOW_DAYS * DAY) out.push({ from: c, to: Math.min(c + WINDOW_DAYS * DAY, p.to) });
  return out;
}

interface RunOutput {
  trades: SimulatedTrade[];
  curve: Array<{ timestamp: number; equity: number }>;
  windows: StoredWindow[];
  stopPauses: number;
}

function simulate(
  symbols: string[],
  variant: Variant,
  side: SideKey,
  cost: CostKey,
  period: PeriodKey,
  extra: Record<string, number> = {},
): RunOutput {
  const strategy = new TrendRegimeStrategy(new IndicatorsService(), { ...BASE_STRATEGY, allowShort: SIDES[side], ...variant.params, ...extra });
  const risk = new RiskManagerService(RISK);
  const regimeLookback = variant.regimeLookback ?? CANDLE_LOOKBACK;
  let balance = INITIAL;
  const trades: SimulatedTrade[] = [];
  const curve: RunOutput['curve'] = [];
  const windows: StoredWindow[] = [];
  let stopPauses = 0;
  for (const w of windowsOf(PERIODS[period])) {
    const series: SymbolSeries[] = symbols.map((s) => {
      const d = data.get(s)!;
      return {
        symbol: s,
        candles: d.h1.filter((c) => c.closeTime >= w.from - CANDLE_LOOKBACK * H && c.closeTime <= w.to),
        regimeCandles: d.h4.filter((c) => c.closeTime >= w.from - regimeLookback * 4 * H && c.closeTime <= w.to),
      };
    });
    const start = balance;
    const res = new BacktestRunner(strategy, risk, {
      strategy: 'TrendRegimeStrategy', symbol: symbols[0], initialBalance: balance, ...COSTS[cost],
      candleLookback: CANDLE_LOOKBACK, regimeLookback: variant.regimeLookback, tradeFrom: w.from,
    }).runPortfolio(series);
    balance = res.finalBalance;
    trades.push(...res.trades);
    curve.push(...res.equityCurve);
    stopPauses += res.stopPauses;
    const summary = computeMetrics(res.trades, start);
    windows.push({ from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(), summary, tradeCount: res.trades.length, startBalance: start, returnPct: summary.totalPnl / start });
  }
  return { trades, curve, windows, stopPauses };
}

const fullWindows = (ws: StoredWindow[]) => ws.filter((w) => Date.parse(w.to) - Date.parse(w.from) >= MIN_WINDOW_DAYS * DAY);

interface Report {
  trades: number; long: number; short: number; winRate: number; profitFactor: number; expectancy: number;
  avgReturnPct: number; avgR: number | null; topDecileShare: number | null; totalPnl: number; returnPct: number;
  maxLosingStreak: number; avgHoldHours: number; stopPauses: number;
  bySide: MetricsSummary['bySide']; exitReasons: Record<string, number>;
  ra: RiskAdjustedMetrics | null; windowsPositive: number; windowsCounted: number; tradesPerWindow: number[];
  costTotal: number; costShareOfGross: number | null;
}

function report(out: RunOutput): Report {
  const m = computeMetrics(out.trades, INITIAL);
  const full = fullWindows(out.windows);
  const costTotal = out.trades.reduce((s, t) => s + t.fees + t.slippageCost, 0);
  return {
    trades: m.tradeCount, long: m.longCount, short: m.shortCount, winRate: m.winRate, profitFactor: m.profitFactor,
    expectancy: m.expectancy, avgReturnPct: m.avgReturnPct, avgR: m.rStats?.avgR ?? null, topDecileShare: m.rStats?.topDecilePnlShare ?? null,
    totalPnl: m.totalPnl, returnPct: m.totalPnl / INITIAL, maxLosingStreak: m.maxLosingStreak, avgHoldHours: m.avgHoldTimeMs / H,
    stopPauses: out.stopPauses, bySide: m.bySide, exitReasons: m.exitReasonBreakdown,
    ra: computeRiskAdjusted(out.curve, INITIAL),
    windowsPositive: full.filter((w) => (w.returnPct ?? 0) > 0).length, windowsCounted: full.length,
    tradesPerWindow: out.windows.map((w) => w.tradeCount),
    costTotal, costShareOfGross: m.grossProfit > 0 ? costTotal / m.grossProfit : null,
  };
}

function buyAndHold(period: PeriodKey) {
  const p = PERIODS[period];
  const by: Record<string, number> = {};
  for (const s of SYMBOLS) {
    const c = data.get(s)!.h1.filter((k) => k.closeTime >= p.from && k.closeTime <= p.to);
    by[s] = c[c.length - 1].close / c[0].close - 1;
  }
  return { bySymbol: by, equalWeight: Object.values(by).reduce((a, b) => a + b, 0) / SYMBOLS.length };
}

/** Everything a later analysis needs from one simulation (no trade list: it's big). */
interface Stored {
  report: Report;
  summary: MetricsSummary;
  windows: StoredWindow[];
}

interface Job {
  key: string;
  run: () => RunOutput;
}

const key = (...p: string[]) => p.join('|');

/** The full, fixed list of simulations, in a stable order (shards pick by index). */
function jobs(): Job[] {
  const list: Job[] = [];
  const sides = Object.keys(SIDES) as SideKey[];
  const costs = Object.keys(COSTS) as CostKey[];
  const periods = Object.keys(PERIODS) as PeriodKey[];
  // Main runs: 5-asset portfolio, every variant × side × cost × period.
  for (const v of VARIANTS) for (const side of sides) for (const cost of costs) for (const period of periods) {
    list.push({ key: key('PORTFOLIO', v.key, side, cost, period), run: () => simulate(SYMBOLS, v, side, cost, period) });
  }
  // Per asset (alone, 10k), 1× and 2× costs.
  for (const s of SYMBOLS) for (const v of VARIANTS) for (const side of sides) for (const cost of costs) for (const period of periods) {
    list.push({ key: key(s, v.key, side, cost, period), run: () => simulate([s], v, side, cost, period) });
  }
  // Sensitivity (OOS, long only, 1×, portfolio): reported, never used to choose.
  for (const v of VARIANTS) for (const extra of SENSITIVITY) {
    list.push({ key: key('SENS', v.key, JSON.stringify(extra)), run: () => simulate(SYMBOLS, v, 'L', '1x', 'OOS', extra) });
  }
  return list;
}

const PARTS = process.env.RESEARCH_PARTS ?? join(tmpdir(), 'krypto-research-parts');
const PHASE = process.env.RESEARCH_PHASE ?? 'all';

async function simulatePhase(shard: number, shards: number) {
  await loadData();
  const out: Record<string, Stored> = {};
  const mine = jobs().filter((_, i) => i % shards === shard);
  const t0 = Date.now();
  for (const [n, job] of mine.entries()) {
    const run = job.run();
    out[job.key] = { report: report(run), summary: computeMetrics(run.trades, INITIAL), windows: run.windows };
    console.log(`[shard ${shard}/${shards}] ${n + 1}/${mine.length} ${job.key} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  mkdirSync(PARTS, { recursive: true });
  writeFileSync(join(PARTS, `part-${shard}-of-${shards}.json`), JSON.stringify(out));
}

function asStoredRun(id: string, s: Stored, period: PeriodKey | 'ALL', windows = s.windows): RunForAnalysis {
  const from = period === 'ALL' ? PERIODS.DEV.from : PERIODS[period].from;
  const to = period === 'ALL' ? PERIODS.OOS.to : PERIODS[period].to;
  return {
    runId: id, strategy: 'TrendRegimeStrategy', symbols: SYMBOLS, timeframe: '1h', from: new Date(from), to: new Date(to),
    engineVersion: 2, params: { initialBalance: INITIAL }, summary: s.summary, walkForwardWindows: fullWindows(windows),
  };
}

async function analyzePhase() {
  await loadData();
  const stored: Record<string, Stored> = {};
  for (const f of readdirSync(PARTS).filter((n) => n.startsWith('part-'))) Object.assign(stored, JSON.parse(readFileSync(join(PARTS, f), 'utf-8')));
  const missing = jobs().filter((j) => !stored[j.key]).map((j) => j.key);
  if (missing.length) throw new Error(`missing ${missing.length} simulations, e.g. ${missing.slice(0, 3).join(', ')}`);
  const reports: Record<string, Report> = Object.fromEntries(Object.entries(stored).filter(([k]) => !k.startsWith('SENS|')).map(([k, s]) => [k, s.report]));
  const sensitivity: Record<string, Report> = Object.fromEntries(Object.entries(stored).filter(([k]) => k.startsWith('SENS|')).map(([k, s]) => [k.slice(5), s.report]));
  const P = (v: string, side: SideKey, cost: CostKey, period: PeriodKey) => stored[key('PORTFOLIO', v, side, cost, period)];

  // DSR: N = 24 trials, Sharpe variance across the 24 OOS 1× portfolio configurations.
  const trialSharpes = [
    ...VARIANTS.flatMap((v) => (['L', 'LS'] as SideKey[]).map((side) => P(v.key, side, '1x', 'OOS').report.ra?.sharpeDaily ?? 0)),
    ...Object.values(sensitivity).map((r) => r.ra?.sharpeDaily ?? 0),
  ];
  const sharpeVar = variance(trialSharpes);
  const dsr: Record<string, number | null> = {};
  for (const v of VARIANTS) for (const side of ['L', 'LS'] as SideKey[]) for (const period of Object.keys(PERIODS) as PeriodKey[]) {
    const ra = P(v.key, side, '1x', period).report.ra;
    dsr[key(v.key, side, period)] = ra ? deflatedSharpe(ra, DSR_TRIALS, sharpeVar).deflatedSharpe : null;
  }

  // PBO over the 4 variants per side, windows of DEV + OOS (1×, portfolio).
  const pbo: Record<string, PboResult> = {};
  for (const side of ['L', 'LS'] as SideKey[]) {
    pbo[side] = probabilityOfBacktestOverfitting(
      VARIANTS.map((v) => asStoredRun(v.key, P(v.key, side, '1x', 'OOS'), 'ALL', [...P(v.key, side, '1x', 'DEV').windows, ...P(v.key, side, '1x', 'OOS').windows])),
    );
  }

  // Criteria, exactly as registered.
  const criteria: Record<string, unknown> = {};
  for (const side of ['L', 'LS'] as SideKey[]) for (const v of VARIANTS) {
    const r1 = P(v.key, side, '1x', 'OOS').report;
    const r2 = P(v.key, side, '2x', 'OOS').report;
    const tradedSides = side === 'L' ? [r1.bySide.LONG.tradeCount] : [r1.bySide.LONG.tradeCount, r1.bySide.SHORT.tradeCount];
    const assetsPf = SYMBOLS.filter((s) => reports[key(s, v.key, side, '1x', 'OOS')].profitFactor > 1).length;
    const A = {
      A1_minTradesPerSide: { value: Math.min(...tradedSides), pass: Math.min(...tradedSides) >= 30 },
      A2_pf: { value: [r1.profitFactor, r2.profitFactor], pass: r1.profitFactor >= 1.1 && r2.profitFactor > 1 },
      A3_dsr: { value: dsr[key(v.key, side, 'OOS')], pass: (dsr[key(v.key, side, 'OOS')] ?? 0) >= 0.95 },
      A4_windowsPositive: { value: `${r1.windowsPositive}/${r1.windowsCounted}`, pass: r1.windowsPositive / r1.windowsCounted >= 0.6 },
      A5_assetsPfAbove1: { value: assetsPf, pass: assetsPf >= 3 },
    };
    let B: Record<string, unknown> | undefined;
    if (v.key !== 'V0') {
      const base1 = P('V0', side, '1x', 'OOS').report;
      const base2 = P('V0', side, '2x', 'OOS').report;
      const cmp = compareRuns(asStoredRun('V0', P('V0', side, '1x', 'OOS'), 'OOS'), asStoredRun(v.key, P(v.key, side, '1x', 'OOS'), 'OOS'));
      const share = cmp.variantWinShare.profitFactorAndExpectancy;
      const ddV = r1.ra?.maxDrawdown ?? 0;
      const ddB = base1.ra?.maxDrawdown ?? 0;
      B = {
        B1_windowsPfAndExpectancy: { value: share, pass: (share ?? 0) >= 0.6 },
        B2_avgR: { value: [r1.avgR, base1.avgR], pass: (r1.avgR ?? -Infinity) >= (base1.avgR ?? Infinity) },
        B3_maxDD: { value: [ddV, ddB], pass: ddV <= 1.2 * ddB },
        B4_pf2x: { value: [r2.profitFactor, base2.profitFactor], pass: r2.profitFactor >= base2.profitFactor },
        B5_pbo: { value: pbo[side].pbo, pass: pbo[side].pbo < 0.5 },
      };
    }
    criteria[key(v.key, side)] = { A, B };
  }
  for (const v of VARIANTS) {
    const l = P(v.key, 'L', '1x', 'OOS').report;
    const ls = P(v.key, 'LS', '1x', 'OOS').report;
    const ls2 = P(v.key, 'LS', '2x', 'OOS').report;
    const shortPf1 = ls.bySide.SHORT.profitFactor;
    const shortPf2 = ls2.bySide.SHORT.profitFactor;
    const cmp = compareRuns(asStoredRun('L', P(v.key, 'L', '1x', 'OOS'), 'OOS'), asStoredRun('LS', P(v.key, 'LS', '1x', 'OOS'), 'OOS'));
    criteria[key(v.key, 'C_short')] = {
      C1_calmar: { value: [ls.ra?.calmar, l.ra?.calmar], pass: (ls.ra?.calmar ?? -Infinity) >= (l.ra?.calmar ?? Infinity) },
      C2_maxDD: { value: [ls.ra?.maxDrawdown, l.ra?.maxDrawdown], pass: (ls.ra?.maxDrawdown ?? Infinity) <= 1.2 * (l.ra?.maxDrawdown ?? 0) },
      C3_shortPf: { value: [shortPf1, shortPf2], pass: shortPf1 > 1.1 && shortPf2 > 1 },
      C4_windows: { value: cmp.variantWinShare.pnl, pass: (cmp.variantWinShare.pnl ?? 0) >= 0.6 },
    };
  }

  const result = {
    generatedAt: new Date().toISOString(),
    protocol: { SYMBOLS, PERIODS: { DEV: PERIODS.DEV, OOS: PERIODS.OOS }, WINDOW_DAYS, MIN_WINDOW_DAYS, COSTS, VARIANTS, DSR_TRIALS, RISK, BASE_STRATEGY },
    buyAndHold: { DEV: buyAndHold('DEV'), OOS: buyAndHold('OOS') },
    reports, sensitivity, dsr, sharpeVariance: sharpeVar, pbo, criteria,
  };
  const outFile = process.env.RESEARCH_OUT ?? join(__dirname, '..', '..', 'docs', 'research', 'variants-results.json');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 1));
  console.log(`research done → ${outFile}`);
}

/**
 * RESEARCH_PHASE=simulate RESEARCH_SHARD=i/N: runs every N-th simulation (parallel processes);
 * RESEARCH_PHASE=analyze: merges the parts and computes DSR, PBO and the criteria;
 * default (all): both in one process (slow: ~2 h).
 */
(RUN ? it : it.skip)('V0–V3 research protocol', async () => {
  if (PHASE === 'simulate' || PHASE === 'all') {
    const [shard, shards] = (process.env.RESEARCH_SHARD ?? '0/1').split('/').map(Number);
    await simulatePhase(shard, shards);
  }
  if (PHASE === 'analyze' || PHASE === 'all') await analyzePhase();
}, 6 * 3_600_000);
