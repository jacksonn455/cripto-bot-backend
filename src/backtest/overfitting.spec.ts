import { withOverfitting } from './backtest.service';
import type { BacktestRun } from './schemas/backtest-run.schema';

const riskAdjusted = {
  days: 730,
  sharpeDaily: 0.08,
  sharpeAnnualized: 0.08 * Math.sqrt(365),
  skewness: 0,
  kurtosis: 3,
  probabilisticSharpe: 0.98,
};
const run = { runId: 'bt_1', strategy: 'TrendRegimeStrategy', riskAdjusted } as unknown as BacktestRun;

describe('withOverfitting (DSR and haircut added when a run is read)', () => {
  it('uses the PSR as the DSR when only one variation was tested', () => {
    const r = withOverfitting(run, { trials: 1, sharpes: [0.08] });
    expect(r.paramVariationsTestedForStrategy).toBe(1);
    expect(r.overfitting).toMatchObject({ trials: 1, deflatedSharpe: 0.98, expectedMaxSharpeAnnualized: 0 });
    expect(r.overfitting!.haircut).toBeCloseTo(0, 6);
  });

  it('deflates against the luck benchmark of the variations tested', () => {
    const r = withOverfitting(run, { trials: 20, sharpes: [0.08, 0.02, -0.01, 0.05, 0.03] });
    expect(r.overfitting!.sharpeVariance).toBeGreaterThan(0);
    expect(r.overfitting!.expectedMaxSharpeAnnualized).toBeGreaterThan(0);
    expect(r.overfitting!.deflatedSharpe).toBeLessThan(0.98);
    expect(r.overfitting!.haircut).toBeGreaterThan(0);
  });

  it('cannot deflate without the Sharpe of at least two variations (older runs)', () => {
    const r = withOverfitting(run, { trials: 8, sharpes: [0.08] });
    expect(r.overfitting!.deflatedSharpe).toBeNull();
    expect(r.overfitting!.trialsWithSharpe).toBe(1);
  });

  it('adds nothing to runs saved before the daily metrics existed', () => {
    const old = { runId: 'bt_0', strategy: 'TrendRegimeStrategy' } as unknown as BacktestRun;
    expect(withOverfitting(old, { trials: 3, sharpes: [] }).overfitting).toBeUndefined();
  });
});
