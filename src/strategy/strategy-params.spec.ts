import { IndicatorsService } from '../indicators/indicators.service';
import { effectiveStrategyParams, StrategyParamsError } from './strategy.interface';
import { TrendRegimeStrategy } from './trend-regime.strategy';

const CONFIG = {
  symbols: ['BTCUSDT'],
  timeframe: '1h',
  regimeTimeframe: '4h',
  emaFast: 20,
  emaSlow: 50,
  emaRegime: 200,
  rsiPeriod: 14,
  rsiMin: 45,
  rsiMax: 70,
  atrPeriod: 14,
  atrStopMultiplier: 2,
  chandelierLookback: 22,
  chandelierAtrMultiplier: 3,
};

describe('TrendRegimeStrategy params', () => {
  const strategy = new TrendRegimeStrategy(new IndicatorsService(), CONFIG);

  it('exposes every numeric parameter and nothing else', () => {
    expect(strategy.getParams()).toEqual({
      emaFast: 20,
      emaSlow: 50,
      emaRegime: 200,
      rsiPeriod: 14,
      rsiMin: 45,
      rsiMax: 70,
      atrPeriod: 14,
      atrStopMultiplier: 2,
      chandelierLookback: 22,
      chandelierAtrMultiplier: 3,
      allowShort: 0,
      adxMin: 0,
      adxPeriod: 14,
      regimeBandPct: 0,
      trailingMode: 0,
      pullbackLookback: 0,
    });
    expect(strategy.paramSpec.map((p) => p.key)).toEqual(Object.keys(strategy.getParams()));
  });

  it('returns a copy with overrides and leaves the live instance untouched', () => {
    const tuned = strategy.withParams({ emaFast: 10, atrStopMultiplier: '2.5' });
    expect(tuned.getParams()).toMatchObject({ emaFast: 10, emaSlow: 50, atrStopMultiplier: 2.5 });
    expect(strategy.getParams().emaFast).toBe(20);
  });

  it.each([
    [{ foo: 1 }, 'unknown parameter "foo"'],
    [{ emaFast: 'abc' }, 'emaFast must be a number'],
    [{ emaFast: 10.5 }, 'emaFast must be an integer'],
    [{ emaFast: 1 }, 'emaFast must be between 2 and 200'],
    [{ emaFast: 60 }, 'emaFast must be lower than emaSlow'],
    [{ rsiMin: 80 }, 'rsiMin must be lower than rsiMax'],
    [{ allowShort: 2 }, 'allowShort must be between 0 and 1'],
    [{ allowShort: 0.5 }, 'allowShort must be an integer'],
    [{ regimeBandPct: 0.5 }, 'regimeBandPct must be between 0 and 0.2'],
  ])('rejects %j', (overrides, message) => {
    expect(() => strategy.withParams(overrides)).toThrow(StrategyParamsError);
    expect(() => strategy.withParams(overrides)).toThrow(message);
  });

  describe('effectiveStrategyParams (what the backtest params hash sees)', () => {
    it('drops the knobs that are off, so old long-only runs keep hashing the same', () => {
      const effective = effectiveStrategyParams(strategy.paramSpec, strategy.getParams());
      expect(effective).not.toHaveProperty('allowShort');
      expect(effective).not.toHaveProperty('adxMin');
      // adxPeriod only matters with the ADX filter on.
      expect(effective).not.toHaveProperty('adxPeriod');
      expect(effective).not.toHaveProperty('regimeBandPct');
      expect(effective).toMatchObject({ emaFast: 20, rsiMax: 70 });
    });

    it('keeps a knob (and what depends on it) once it is turned on', () => {
      const tuned = strategy.withParams({ adxMin: 20, allowShort: 1 });
      const effective = effectiveStrategyParams(tuned.paramSpec, tuned.getParams());
      expect(effective).toMatchObject({ adxMin: 20, adxPeriod: 14, allowShort: 1 });
    });
  });
});
