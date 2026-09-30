import { IndicatorsService } from '../indicators/indicators.service';
import { StrategyParamsError } from './strategy.interface';
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
  ])('rejects %j', (overrides, message) => {
    expect(() => strategy.withParams(overrides)).toThrow(StrategyParamsError);
    expect(() => strategy.withParams(overrides)).toThrow(message);
  });
});
