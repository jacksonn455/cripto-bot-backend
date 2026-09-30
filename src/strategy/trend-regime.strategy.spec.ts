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

function candlesRange(length: number, value: number): number[] {
  return Array.from({ length }, () => value);
}
