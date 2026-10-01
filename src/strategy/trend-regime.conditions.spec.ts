import { IndicatorsService } from '../indicators/indicators.service';
import { Candle } from '../exchange/types/candle.type';
import { TrendRegimeStrategy } from './trend-regime.strategy';

/** `Signal.conditions` is observability only: these tests pin it to the decision actually taken. */
function makeCandles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    symbol: 'BTCUSDT',
    interval: '1h',
    openTime: i * 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    closeTime: i * 60_000 + 59_999,
    quoteVolume: 100 * close,
    trades: 10,
    isClosed: true,
  }));
}

const TINY_CONFIG = {
  symbols: ['BTCUSDT'],
  timeframe: '1h',
  regimeTimeframe: '1h',
  emaFast: 2,
  emaSlow: 3,
  emaRegime: 4,
  rsiPeriod: 3,
  rsiMin: 0,
  rsiMax: 100,
  atrPeriod: 3,
  atrStopMultiplier: 2,
  chandelierLookback: 5,
  chandelierAtrMultiplier: 2,
  allowShort: 0,
};

const makeStrategy = (overrides: Partial<typeof TINY_CONFIG> = {}) =>
  new TrendRegimeStrategy(new IndicatorsService(), { ...TINY_CONFIG, ...overrides });

describe('TrendRegimeStrategy - entry conditions snapshot', () => {
  it('an entry reports all three conditions met, with the values the decision used', () => {
    const signal = makeStrategy().onCandleClosed({ symbol: 'BTCUSDT', candles: makeCandles([100, 95, 90, 85, 80, 75, 90]) });

    expect(signal.action).toBe('ENTER_LONG');
    expect(signal.conditions).toEqual({
      side: 'LONG',
      cross: { ok: true, emaFast: signal.indicators.emaFast, emaSlow: signal.indicators.emaSlow },
      regime: { ok: true, close: 90, ema: signal.indicators.emaRegime, bandPct: 0 },
      rsi: { ok: true, value: signal.indicators.rsi, min: 0, max: 100 },
    });
  });

  it('RSI out of band: only the RSI condition fails, as the reason says', () => {
    const signal = makeStrategy({ rsiMin: 95, rsiMax: 100 }).onCandleClosed({
      symbol: 'BTCUSDT',
      candles: makeCandles([100, 95, 90, 85, 80, 75, 90]),
    });

    expect(signal.action).toBe('NONE');
    expect(signal.reason).toBe('RSI fora da faixa');
    expect(signal.conditions).toMatchObject({ cross: { ok: true }, regime: { ok: true }, rsi: { ok: false, min: 95, max: 100 } });
  });

  it('regime down: the regime condition fails', () => {
    const signal = makeStrategy().onCandleClosed({ symbol: 'BTCUSDT', candles: makeCandles([100, 99, 98, 97, 96, 95, 94, 93]) });

    expect(signal.action).toBe('NONE');
    expect(signal.conditions?.regime.ok).toBe(false);
    expect(signal.conditions!.regime.close).toBeLessThan(signal.conditions!.regime.ema!);
  });

  it('with shorts on and the regime not up, reports the short-side conditions (mirrored RSI band)', () => {
    const signal = makeStrategy({ allowShort: 1, rsiMin: 45, rsiMax: 70 }).onCandleClosed({
      symbol: 'BTCUSDT',
      candles: makeCandles([100, 99, 98, 97, 96, 95, 94, 93]),
    });

    expect(signal.conditions).toMatchObject({ side: 'SHORT', regime: { ok: true }, rsi: { min: 30, max: 55 } });
  });

  it('has no entry conditions while a position is open (exits are judged instead)', () => {
    const signal = makeStrategy().onCandleClosed({
      symbol: 'BTCUSDT',
      candles: makeCandles([100, 95, 90, 85, 80, 75, 90]),
      openPosition: { side: 'LONG', entryPrice: 90, stopLoss: 80 },
    });

    expect(signal.conditions).toBeUndefined();
  });

  it('on random series, "all conditions ok" happens exactly when the strategy enters', () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    const strategy = makeStrategy({ rsiMin: 45, rsiMax: 70 });
    let entries = 0;
    for (let run = 0; run < 300; run++) {
      const closes = [100];
      for (let k = 1; k < 30; k++) closes.push(closes[k - 1] * (1 + (rand() - 0.5) * 0.06));
      const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles: makeCandles(closes) });
      const c = signal.conditions!;
      const allOk = c.cross.ok && c.regime.ok && c.rsi.ok;
      expect(signal.action === 'ENTER_LONG').toBe(allOk);
      if (allOk) entries++;
    }
    expect(entries).toBeGreaterThan(0);
  });
});
