import { IndicatorsService } from '../indicators/indicators.service';
import { Candle } from '../exchange/types/candle.type';
import { TrendRegimeStrategy } from './trend-regime.strategy';
import { StrategyContext } from './strategy.interface';

function makeCandles(closes: number[], ranges?: number[]): Candle[] {
  return closes.map((close, i) => {
    const range = ranges?.[i] ?? 1;
    return {
      symbol: 'BTCUSDT',
      interval: '1h',
      openTime: i * 60_000,
      open: close,
      high: close + range,
      low: close - range,
      close,
      volume: 100,
      closeTime: i * 60_000 + 59_999,
      quoteVolume: 100 * close,
      trades: 10,
      isClosed: true,
    };
  });
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

function makeStrategy(configOverrides: Partial<typeof TINY_CONFIG> = {}) {
  const indicators = new IndicatorsService();
  const strategy = new TrendRegimeStrategy(indicators, { ...TINY_CONFIG, ...configOverrides });
  return { strategy, indicators };
}

describe('TrendRegimeStrategy', () => {
  it('enters long on regime-up + EMA golden cross + RSI in range', () => {
    // Hand-verified: EMA(2)/EMA(3) cross up at the last candle, close(90) > EMA(4)=85.5 (regime up).
    const candles = makeCandles([100, 95, 90, 85, 80, 75, 90]);
    const { strategy, indicators } = makeStrategy();

    const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles });

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const atr = indicators.atr(TINY_CONFIG.atrPeriod, highs, lows, closes);
    const lastAtr = atr[atr.length - 1]!;

    expect(signal.action).toBe('ENTER_LONG');
    expect(signal.price).toBe(90);
    expect(signal.stopLoss).toBeCloseTo(90 - TINY_CONFIG.atrStopMultiplier * lastAtr);
    expect(signal.candleTime).toBe(candles[candles.length - 1].closeTime);
  });

  it('does not enter when RSI is outside the configured band', () => {
    const candles = makeCandles([100, 95, 90, 85, 80, 75, 90]);
    const { strategy } = makeStrategy({ rsiMin: 95, rsiMax: 100 });

    const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles });

    expect(signal.action).toBe('NONE');
    expect(signal.reason).toContain('RSI fora da faixa');
  });

  it('does not enter when the higher-timeframe regime is down', () => {
    // Strictly falling series: last close is below EMA(4), so regime is down.
    const candles = makeCandles([120, 115, 110, 105, 100, 95, 90]);
    const { strategy } = makeStrategy();

    const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles });

    expect(signal.action).toBe('NONE');
    // Reasons are ASCII-only on purpose (they go to logs and Telegram as-is).
    expect(signal.reason).toContain('regime nao esta em alta');
  });

  it('exits an open position when EMA fast crosses back below EMA slow', () => {
    // Mirror of the entry scenario: uptrend then a drop causes fast to cross below slow.
    const candles = makeCandles([75, 80, 85, 90, 95, 100, 85]);
    const { strategy } = makeStrategy();

    const signal = strategy.onCandleClosed({
      symbol: 'BTCUSDT',
      candles,
      openPosition: { side: 'LONG', entryPrice: 80, stopLoss: 70 },
    });

    expect(signal.action).toBe('EXIT');
    expect(signal.reason).toContain('cruzou abaixo');
  });

  it('does not exit an open position when there is no cross or chandelier breach', () => {
    // Mild, steady uptrend: EMA fast stays above EMA slow, tight range keeps price above trailing stop.
    const candles = makeCandles([100, 101, 102, 103, 104, 105, 106], candlesRange(7, 0.2));
    const { strategy } = makeStrategy();

    const signal = strategy.onCandleClosed({
      symbol: 'BTCUSDT',
      candles,
      openPosition: { side: 'LONG', entryPrice: 100, stopLoss: 95 },
    });

    expect(signal.action).toBe('NONE');
    expect(signal.reason).toBe('Posição aberta, sem gatilho de saída');
  });

  it('throws if the last candle is not closed (no lookahead)', () => {
    const candles = makeCandles([100, 95, 90, 85, 80, 75, 90]);
    candles[candles.length - 1].isClosed = false;
    const { strategy } = makeStrategy();

    expect(() =>
      strategy.onCandleClosed({ symbol: 'BTCUSDT', candles } as StrategyContext),
    ).toThrow(/closed/i);
  });
});

describe('TrendRegimeStrategy short side (allowShort=1)', () => {
  // Every scenario below is the long scenario reflected around 100 (p -> 200 - p). EMAs are
  // linear, so they reflect exactly; RSI becomes 100 - RSI; ATR is unchanged (same ranges).
  const mirror = (closes: number[]) => closes.map((c) => 200 - c);

  it('enters short on regime-down + EMA death cross + RSI in the mirrored band', () => {
    const candles = makeCandles(mirror([100, 95, 90, 85, 80, 75, 90])); // [100, 105, ..., 125, 110]
    const { strategy, indicators } = makeStrategy({ allowShort: 1 });

    const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles });

    const atr = indicators.atr(
      TINY_CONFIG.atrPeriod,
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close),
    );
    const lastAtr = atr[atr.length - 1]!;
    expect(signal.action).toBe('ENTER_SHORT');
    expect(signal.price).toBe(110);
    // Stop ABOVE the entry for a short, same ATR distance as the mirrored long.
    expect(signal.stopLoss).toBeCloseTo(110 + TINY_CONFIG.atrStopMultiplier * lastAtr);
    expect(signal.stopLoss!).toBeGreaterThan(signal.price);
    expect(signal.reason).toContain('regime de baixa');
  });

  it('is symmetric: the short stop distance equals the mirrored long stop distance', () => {
    const { strategy } = makeStrategy({ allowShort: 1 });
    const long = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles: makeCandles([100, 95, 90, 85, 80, 75, 90]) });
    const short = strategy.onCandleClosed({
      symbol: 'BTCUSDT',
      candles: makeCandles(mirror([100, 95, 90, 85, 80, 75, 90])),
    });
    expect(long.action).toBe('ENTER_LONG');
    expect(short.action).toBe('ENTER_SHORT');
    expect(short.stopLoss! - short.price).toBeCloseTo(long.price - long.stopLoss!);
  });

  it('never shorts when allowShort is off (default): same scenario is a HOLD', () => {
    const candles = makeCandles(mirror([100, 95, 90, 85, 80, 75, 90]));
    const { strategy } = makeStrategy();

    const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles });

    expect(signal.action).toBe('NONE');
    expect(signal.reason).toContain('regime nao esta em alta');
  });

  it('rejects the short when RSI is outside the mirrored band', () => {
    // Long band [95,100] mirrors to [0,5] for shorts; the death-cross candle's RSI is well above it.
    const candles = makeCandles(mirror([100, 95, 90, 85, 80, 75, 90]));
    const { strategy } = makeStrategy({ allowShort: 1, rsiMin: 95, rsiMax: 100 });

    const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles });

    expect(signal.action).toBe('NONE');
    expect(signal.reason).toContain('short: RSI fora da faixa');
  });

  it('does not short in an up regime, even with shorts enabled', () => {
    // Steady rise: regime up, so only the long rules apply (and there is no golden cross here).
    const candles = makeCandles([80, 85, 90, 95, 100, 105, 110]);
    const { strategy } = makeStrategy({ allowShort: 1 });

    const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles });

    expect(signal.action).toBe('NONE');
  });

  it('exits a short when EMA fast crosses back above EMA slow', () => {
    const candles = makeCandles(mirror([75, 80, 85, 90, 95, 100, 85]));
    const { strategy } = makeStrategy({ allowShort: 1 });

    const signal = strategy.onCandleClosed({
      symbol: 'BTCUSDT',
      candles,
      openPosition: { side: 'SHORT', entryPrice: 120, stopLoss: 130 },
    });

    expect(signal.action).toBe('EXIT');
    expect(signal.reason).toContain('cruzou acima');
  });

  it('exits a short on the chandelier trailing stop (close above lowest low + N*ATR)', () => {
    // 30 candles falling 1/candle, then a +5 bounce: EMA2 stays below EMA20 (no cross), but the
    // bounce clears lowestLow + 1*ATR.
    const closes = [...Array.from({ length: 30 }, (_, i) => 200 - i), 176];
    const candles = makeCandles(closes, candlesRange(closes.length, 0.2));
    const { strategy } = makeStrategy({ allowShort: 1, emaSlow: 20, chandelierAtrMultiplier: 1 });

    const signal = strategy.onCandleClosed({
      symbol: 'BTCUSDT',
      candles,
      openPosition: { side: 'SHORT', entryPrice: 190, stopLoss: 200 },
    });

    expect(signal.action).toBe('EXIT');
    expect(signal.reason).toContain('Chandelier exit (short)');
  });

  it('keeps a short open while the downtrend continues', () => {
    const candles = makeCandles(mirror([100, 101, 102, 103, 104, 105, 106]), candlesRange(7, 0.2));
    const { strategy } = makeStrategy({ allowShort: 1 });

    const signal = strategy.onCandleClosed({
      symbol: 'BTCUSDT',
      candles,
      openPosition: { side: 'SHORT', entryPrice: 100, stopLoss: 105 },
    });

    expect(signal.action).toBe('NONE');
    expect(signal.reason).toBe('Posição aberta, sem gatilho de saída');
  });
});

function candlesRange(length: number, value: number): number[] {
  return Array.from({ length }, () => value);
}

describe('TrendRegimeStrategy research filters (off by default)', () => {
  // Same golden-cross fixture as above: close 90 vs EMA(4) = 85.5 on the last candle.
  const candles = makeCandles([100, 95, 90, 85, 80, 75, 90]);
  const withKnobs = (knobs: { adxMin?: number; adxPeriod?: number; regimeBandPct?: number }) =>
    new TrendRegimeStrategy(new IndicatorsService(), { ...TINY_CONFIG, ...knobs });

  it('adds no ADX to the snapshot while the filter is off', () => {
    const signal = withKnobs({}).onCandleClosed({ symbol: 'BTCUSDT', candles });
    expect(signal.action).toBe('ENTER_LONG');
    expect(signal.indicators).not.toHaveProperty('adx');
  });

  it('blocks the entry when ADX is below adxMin, and says so', () => {
    const signal = withKnobs({ adxMin: 100, adxPeriod: 2 }).onCandleClosed({ symbol: 'BTCUSDT', candles });
    expect(signal.action).toBe('NONE');
    expect(signal.reason).toContain('ADX abaixo de 100');
    expect(signal.indicators.adx).toBeDefined();
  });

  it('lets the entry through when ADX clears a low adxMin', () => {
    const signal = withKnobs({ adxMin: 1, adxPeriod: 2 }).onCandleClosed({ symbol: 'BTCUSDT', candles });
    expect(signal.action).toBe('ENTER_LONG');
    expect(signal.indicators.adx).toBeGreaterThanOrEqual(1);
  });

  it('with a regime band, needs the close beyond EMA × (1 + band)', () => {
    // 85.5 × 1.10 = 94.05 > 90: not an up regime yet. 85.5 × 1.05 = 89.8 < 90: up.
    const wide = withKnobs({ regimeBandPct: 0.1 }).onCandleClosed({ symbol: 'BTCUSDT', candles });
    expect(wide.action).toBe('NONE');
    expect(wide.reason).toContain('regime nao esta em alta');
    expect(withKnobs({ regimeBandPct: 0.05 }).onCandleClosed({ symbol: 'BTCUSDT', candles }).action).toBe('ENTER_LONG');
  });
});

describe('TrendRegimeStrategy research variants (backtest only, off by default)', () => {
  const withKnobs = (knobs: { trailingMode?: number; pullbackLookback?: number; allowShort?: number; emaSlow?: number; chandelierAtrMultiplier?: number }) =>
    new TrendRegimeStrategy(new IndicatorsService(), { ...TINY_CONFIG, ...knobs });

  describe('V3 pullback entry (pre-registered rule)', () => {
    // Steady +1 climb (lows touch EMA2 every candle), then a close above the previous high.
    const up = makeCandles([...Array.from({ length: 16 }, (_, i) => 100 + i), 118]);

    it('enters long on the resumption after a touch of EMA fast in an established uptrend', () => {
      const signal = withKnobs({ pullbackLookback: 3 }).onCandleClosed({ symbol: 'BTCUSDT', candles: up });
      expect(signal.action).toBe('ENTER_LONG');
      expect(signal.indicators.pullback).toBe(1);
      expect(signal.reason).toContain('Pullback');
      expect(signal.stopLoss).toBeLessThan(118);
    });

    it('does nothing with the rule off (default): no fresh cross, no entry', () => {
      expect(withKnobs({}).onCandleClosed({ symbol: 'BTCUSDT', candles: up }).action).toBe('NONE');
    });

    it('needs the touch: a trend that never came back to EMA fast is not a pullback', () => {
      const noTouch = makeCandles([...Array.from({ length: 16 }, (_, i) => 100 + i), 118], candlesRange(17, 0));
      expect(withKnobs({ pullbackLookback: 3 }).onCandleClosed({ symbol: 'BTCUSDT', candles: noTouch }).action).toBe('NONE');
    });

    it('needs the confirmation: no close above the previous high, no entry', () => {
      const flatEnd = makeCandles([...Array.from({ length: 16 }, (_, i) => 100 + i), 115.5]);
      expect(withKnobs({ pullbackLookback: 3 }).onCandleClosed({ symbol: 'BTCUSDT', candles: flatEnd }).action).toBe('NONE');
    });

    it('mirrors for shorts (only with shorts on)', () => {
      const down = makeCandles([...Array.from({ length: 16 }, (_, i) => 200 - i), 182]);
      const signal = withKnobs({ pullbackLookback: 3, allowShort: 1 }).onCandleClosed({ symbol: 'BTCUSDT', candles: down });
      expect(signal.action).toBe('ENTER_SHORT');
      expect(signal.indicators.pullback).toBe(1);
      expect(signal.stopLoss).toBeGreaterThan(182);
      expect(withKnobs({ pullbackLookback: 3 }).onCandleClosed({ symbol: 'BTCUSDT', candles: down }).action).toBe('NONE');
    });
  });

  describe('V1 trailing since entry', () => {
    const candles = makeCandles([100, 101, 102, 103, 104, 105, 106], candlesRange(7, 0.2));
    const position = { side: 'LONG' as const, entryPrice: 102, stopLoss: 95, entryTime: candles[2].closeTime };

    it('proposes highest high since entry − m × ATR as the new stop', () => {
      const signal = withKnobs({ trailingMode: 1 }).onCandleClosed({ symbol: 'BTCUSDT', candles, openPosition: position });
      expect(signal.action).toBe('NONE');
      // Highest high after the entry candle = 106.2 (last candle); ATR(3) of a tight +1 climb ≈ 1.
      expect(signal.trailingStop).toBeLessThan(106.2);
      expect(signal.trailingStop).toBeGreaterThan(102);
    });

    it('sends no trailing level in the default mode, or before a candle has closed after the entry', () => {
      expect(withKnobs({}).onCandleClosed({ symbol: 'BTCUSDT', candles, openPosition: position }).trailingStop).toBeUndefined();
      const justEntered = { ...position, entryTime: candles[6].closeTime };
      expect(withKnobs({ trailingMode: 1 }).onCandleClosed({ symbol: 'BTCUSDT', candles, openPosition: justEntered }).trailingStop).toBeUndefined();
    });

    it('replaces the close-based chandelier exit (that scenario now just tightens the stop)', () => {
      const closes = [...Array.from({ length: 30 }, (_, i) => 200 - i), 176];
      const bounce = makeCandles(closes, candlesRange(closes.length, 0.2));
      const short = { side: 'SHORT' as const, entryPrice: 190, stopLoss: 200, entryTime: bounce[10].closeTime };
      const knobs = { allowShort: 1, emaSlow: 20, chandelierAtrMultiplier: 1 };
      expect(withKnobs(knobs).onCandleClosed({ symbol: 'BTCUSDT', candles: bounce, openPosition: short }).action).toBe('EXIT');
      const trailing = withKnobs({ ...knobs, trailingMode: 1 }).onCandleClosed({ symbol: 'BTCUSDT', candles: bounce, openPosition: short });
      expect(trailing.action).toBe('NONE');
      expect(trailing.trailingStop).toBeLessThan(200);
    });
  });
});
