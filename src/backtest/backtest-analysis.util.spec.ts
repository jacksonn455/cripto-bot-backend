import { computeMetrics } from '../reports/metrics.util';
import { compareRuns, probabilityOfBacktestOverfitting, PboInputError, RunForAnalysis } from './backtest-analysis.util';

const DAY = 86_400_000;

/** A run whose walk-forward window i made returns[i] (fraction of a 10 000 balance), via one trade. */
function makeRun(runId: string, returns: number[], overrides: Partial<RunForAnalysis> = {}): RunForAnalysis {
  const all: Parameters<typeof computeMetrics>[0] = [];
  const windows = returns.map((ret, i) => {
    const trades = ret === 0 ? [] : [{ pnl: ret * 10_000, pnlPct: ret * 100, entryTime: i * 90 * DAY, exitTime: i * 90 * DAY + 1 }];
    all.push(...trades);
    return {
      from: new Date(i * 90 * DAY).toISOString(),
      to: new Date((i + 1) * 90 * DAY).toISOString(),
      summary: computeMetrics(trades, 10_000),
      tradeCount: trades.length,
      startBalance: 10_000,
      returnPct: ret,
    };
  });
  return {
    runId,
    strategy: 'TrendRegimeStrategy',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    timeframe: '1h',
    from: new Date(0),
    to: new Date(returns.length * 90 * DAY),
    engineVersion: 2,
    params: { initialBalance: 10_000 },
    summary: computeMetrics(all, 10_000),
    walkForwardWindows: windows,
    ...overrides,
  };
}

describe('compareRuns (baseline vs variant, window by window)', () => {
  it('counts the windows the variant won', () => {
    const baseline = makeRun('a', [0.01, 0.02, -0.01, 0.03]);
    const variant = makeRun('b', [0.02, 0.01, 0.01, 0.04]);
    const c = compareRuns(baseline, variant);
    expect(c.comparable).toBe(true);
    expect(c.windows).toHaveLength(4);
    expect(c.windows.map((w) => w.variantBetter.pnl)).toEqual([true, false, true, true]);
    expect(c.variantWinShare.pnl).toBeCloseTo(0.75);
    expect(c.warnings).toEqual([]);
  });

  it('flags different periods, symbols and engine versions as not comparable', () => {
    const baseline = makeRun('a', [0.01, 0.02]);
    const variant = makeRun('b', [0.01, 0.02, 0.03], { symbols: ['BTCUSDT'], engineVersion: undefined });
    const c = compareRuns(baseline, variant);
    expect(c.comparable).toBe(false);
    expect(c.warnings.join(' ')).toMatch(/Símbolos diferentes/);
    expect(c.warnings.join(' ')).toMatch(/Períodos diferentes/);
    expect(c.warnings.join(' ')).toMatch(/versões diferentes do motor/);
  });

  it('marks the result inconclusive below 30 trades on a traded side', () => {
    const c = compareRuns(makeRun('a', [0.01, 0.02]), makeRun('b', [0.02, 0.03]));
    expect(c.sample.inconclusive).toBe(true);
    expect(c.sample.minTradesPerSide).toBe(30);
  });

  it('leaves profit factor/expectancy uncompared in a window where a side has no trades', () => {
    const c = compareRuns(makeRun('a', [0, 0.01]), makeRun('b', [0.01, 0.02]));
    expect(c.windows[0].variantBetter).toMatchObject({ pnl: true, profitFactor: null, expectancy: null });
  });

  it('warns when a run has no walk-forward', () => {
    const c = compareRuns(makeRun('a', [0.01]), makeRun('b', [0.01], { walkForwardWindows: undefined }));
    expect(c.comparable).toBe(false);
    expect(c.warnings.join(' ')).toMatch(/não tem walk-forward/);
  });
});

describe('probabilityOfBacktestOverfitting (CSCV)', () => {
  it('is ~0 when one variant dominates in every window', () => {
    const good = makeRun('good', [0.05, 0.04, 0.06, 0.05, 0.04, 0.05]);
    const bad = makeRun('bad', [0.01, 0.0, 0.01, -0.01, 0.0, 0.01]);
    const worse = makeRun('worse', [-0.02, -0.01, -0.02, -0.03, -0.01, -0.02]);
    const r = probabilityOfBacktestOverfitting([good, bad, worse]);
    expect(r.blocks).toBe(6);
    expect(r.combinations).toBe(20); // C(6, 3)
    expect(r.pbo).toBe(0);
    expect(r.probOosLoss).toBe(0);
    expect(r.selected.find((s) => s.runId === 'good')!.count).toBe(20);
  });

  it('is high when the in-sample winner reverses out of sample (pure noise fitting)', () => {
    // Each variant shines in a different half: whatever wins in-sample loses out of sample.
    const a = makeRun('a', [0.05, 0.05, -0.05, -0.05]);
    const b = makeRun('b', [-0.05, -0.05, 0.05, 0.05]);
    const r = probabilityOfBacktestOverfitting([a, b]);
    expect(r.pbo).toBeGreaterThan(0.5);
  });

  it('groups many windows into at most 16 blocks', () => {
    const returns = Array.from({ length: 20 }, (_, i) => (i % 3) / 100);
    const r = probabilityOfBacktestOverfitting([makeRun('a', returns), makeRun('b', returns.map((x) => x / 2))]);
    expect(r.windows).toBe(20);
    expect(r.blocks).toBe(16);
    expect(r.combinations).toBe(12870); // C(16, 8)
  });

  it('rejects runs with different windows or too few of them', () => {
    expect(() => probabilityOfBacktestOverfitting([makeRun('a', [0.01, 0.02, 0.03, 0.04]), makeRun('b', [0.01, 0.02, 0.03])])).toThrow(
      PboInputError,
    );
    expect(() => probabilityOfBacktestOverfitting([makeRun('a', [0.01, 0.02, 0.03]), makeRun('b', [0.01, 0.02, 0.03])])).toThrow(
      /at least 4 walk-forward windows/,
    );
    expect(() => probabilityOfBacktestOverfitting([makeRun('a', [0.01, 0.02, 0.03, 0.04])])).toThrow(/at least 2 runs/);
  });
});
