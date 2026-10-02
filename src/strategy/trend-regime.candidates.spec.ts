import { aggregateCandles, syntheticCandles } from '../candidates/testing/synthetic-candles';
import { IndicatorsService } from '../indicators/indicators.service';
import { strategyWindowSize } from './strategy-window';
import { TrendRegimeStrategy } from './trend-regime.strategy';

const BASE = {
  symbols: ['BTCUSDT'], timeframe: '1h', regimeTimeframe: '4h', emaFast: 20, emaSlow: 50, emaRegime: 200,
  rsiPeriod: 14, rsiMin: 45, rsiMax: 70, atrPeriod: 14, atrStopMultiplier: 2, chandelierLookback: 22, chandelierAtrMultiplier: 3,
};
const W = strategyWindowSize(200);
const h1 = syntheticCandles({ count: 4000, seed: 11 });
const h4 = aggregateCandles(h1, 4);

function* evaluations(strategy: TrendRegimeStrategy) {
  let r = 0;
  for (let i = W; i < h1.length; i++) {
    while (r < h4.length && h4[r].closeTime <= h1[i].closeTime) r++;
    yield strategy.onCandleClosed({ symbol: 'BTCUSDT', candles: h1.slice(i + 1 - W, i + 1), regimeCandles: h4.slice(Math.max(0, r - W), r) });
  }
}

describe('TrendRegimeStrategy candidate reporting (observability only)', () => {
  const configs = {
    default: {},
    shorts: { allowShort: 1 },
    adxAndBand: { allowShort: 1, adxMin: 20, regimeBandPct: 0.01 },
    pullback: { allowShort: 1, pullbackLookback: 5 },
  };

  it.each(Object.entries(configs))('%s: an accepted candidate exists exactly when the strategy enters, on the same side and stop', (_name, extra) => {
    const strategy = new TrendRegimeStrategy(new IndicatorsService(), { ...BASE, ...extra });
    let entries = 0;
    let rejected = 0;
    for (const signal of evaluations(strategy)) {
      const accepted = (signal.candidates ?? []).filter((c) => c.accepted);
      rejected += (signal.candidates ?? []).length - accepted.length;
      if (signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT') {
        entries++;
        expect(accepted).toHaveLength(1);
        expect(accepted[0].side).toBe(signal.action === 'ENTER_LONG' ? 'LONG' : 'SHORT');
        expect(accepted[0].stopLoss).toBe(signal.stopLoss);
        expect(accepted[0].price).toBe(signal.price);
        expect(accepted[0].setupType).toBe(signal.indicators.pullback === 1 ? 'PULLBACK' : 'EMA_CROSS');
      } else {
        expect(accepted).toHaveLength(0);
      }
    }
    // The series is long enough to exercise both paths.
    expect(entries).toBeGreaterThan(5);
    expect(rejected).toBeGreaterThan(5);
  });

  it('reports a short cross as SIDE-rejected when shorts are off, with every other gate still evaluated', () => {
    const strategy = new TrendRegimeStrategy(new IndicatorsService(), BASE);
    const shorts = [...evaluations(strategy)].flatMap((s) => s.candidates ?? []).filter((c) => c.side === 'SHORT');
    expect(shorts.length).toBeGreaterThan(0);
    for (const c of shorts) {
      expect(c.accepted).toBe(false);
      expect(c.gates.map((g) => g.gate)).toEqual(['SIDE', 'REGIME', 'RSI', 'INDICATORS']);
      expect(c.gates[0]).toEqual({ gate: 'SIDE', ok: false });
      expect(c.stopLoss).toBeGreaterThan(c.price);
    }
  });

  it('candles with no triggered setup carry no candidates (the signal shape is unchanged)', () => {
    const strategy = new TrendRegimeStrategy(new IndicatorsService(), BASE);
    const quiet = [...evaluations(strategy)].filter((s) => s.action === 'NONE' && !s.candidates);
    expect(quiet.length).toBeGreaterThan(1000);
    for (const s of quiet.slice(0, 50)) expect(Object.keys(s)).not.toContain('candidates');
  });
});
