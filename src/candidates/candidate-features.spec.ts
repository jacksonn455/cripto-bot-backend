import { TradingDataTools } from '../ai/tools/trading-data.tools';
import { IndicatorsService } from '../indicators/indicators.service';
import { lastClosedCandles, strategyWindowSize } from '../strategy/strategy-window';
import { TrendRegimeStrategy } from '../strategy/trend-regime.strategy';
import { buildCandidateFeatures, featureParamsFrom } from './candidate-features';
import { candidateId, opportunityId } from './candidate-id';
import { aggregateCandles, syntheticCandles } from './testing/synthetic-candles';

const CONFIG = {
  symbols: ['BTCUSDT'], timeframe: '1h', regimeTimeframe: '4h', emaFast: 20, emaSlow: 50, emaRegime: 200,
  rsiPeriod: 14, rsiMin: 45, rsiMax: 70, atrPeriod: 14, atrStopMultiplier: 2, chandelierLookback: 22,
  chandelierAtrMultiplier: 3, allowShort: 1, adxMin: 20, adxPeriod: 14, regimeBandPct: 0.01,
};
const WINDOW = strategyWindowSize(CONFIG.emaRegime);
const h1 = syntheticCandles({ count: 3000, seed: 7 });
const h4 = aggregateCandles(h1, 4);

/** The windows the live loop / backtest hand the strategy at 1h candle `i`. */
function windowsAt(i: number) {
  const candles = h1.slice(i + 1 - WINDOW, i + 1);
  const closeTime = candles[candles.length - 1].closeTime;
  const regimeEnd = h4.filter((c) => c.closeTime <= closeTime).length;
  return { candles, regimeCandles: h4.slice(Math.max(0, regimeEnd - WINDOW), regimeEnd) };
}

describe('candidate identity', () => {
  const identity = { symbol: 'btcusdt', timeframe: '1h', candleCloseTime: 1_759_276_799_999, setupType: 'EMA_CROSS' as const, side: 'LONG' as const };

  it('same input → same id, in the documented mode:symbol:timeframe:candleClose:setupType:side shape', () => {
    expect(candidateId('PAPER', identity)).toBe('PAPER:BTCUSDT:1h:1759276799999:EMA_CROSS:LONG');
    expect(candidateId('PAPER', { ...identity })).toBe(candidateId('PAPER', identity));
  });

  it('the opportunity id joins the same opportunity across modes; every identity field matters', () => {
    expect(opportunityId(identity)).toBe('BTCUSDT:1h:1759276799999:EMA_CROSS:LONG');
    expect(candidateId('BACKTEST', identity).endsWith(opportunityId(identity))).toBe(true);
    const variants = [
      candidateId('LIVE', identity),
      candidateId('PAPER', { ...identity, side: 'SHORT' }),
      candidateId('PAPER', { ...identity, setupType: 'PULLBACK' }),
      candidateId('PAPER', { ...identity, timeframe: '4h' }),
      candidateId('PAPER', { ...identity, candleCloseTime: identity.candleCloseTime + 1 }),
      candidateId('PAPER', { ...identity, symbol: 'ETHUSDT' }),
    ];
    expect(new Set([candidateId('PAPER', identity), ...variants]).size).toBe(variants.length + 1);
  });
});

describe('buildCandidateFeatures', () => {
  const params = featureParamsFrom(new TrendRegimeStrategy(new IndicatorsService(), CONFIG).getParams())!;

  it('is deterministic: same candles → same features', () => {
    const { candles, regimeCandles } = windowsAt(1500);
    const a = buildCandidateFeatures(candles, regimeCandles, params);
    const b = buildCandidateFeatures(candles.map((c) => ({ ...c })), regimeCandles.map((c) => ({ ...c })), params);
    expect(b).toEqual(a);
    expect(a.atrToPrice).toBeCloseTo(a.atr! / a.close, 12);
    expect(a.emaSpreadAtr).toBeCloseTo((a.emaFast! - a.emaSlow!) / a.atr!, 12);
    expect(a.regime.distance).toBeCloseTo(a.regime.close! / a.regime.ema! - 1, 12);
  });

  it('gives exactly the values the strategy decided on (EMA200 regime, EMAs, RSI, ATR, ADX), candle after candle', () => {
    const strategy = new TrendRegimeStrategy(new IndicatorsService(), CONFIG);
    for (let i = 1200; i < 3000; i += 37) {
      const { candles, regimeCandles } = windowsAt(i);
      const signal = strategy.onCandleClosed({ symbol: 'BTCUSDT', candles, regimeCandles });
      const f = buildCandidateFeatures(candles, regimeCandles, params);
      expect(f.emaFast).toBe(signal.indicators.emaFast);
      expect(f.emaSlow).toBe(signal.indicators.emaSlow);
      expect(f.rsi).toBe(signal.indicators.rsi);
      expect(f.atr).toBe(signal.indicators.atr);
      expect(f.regime.ema).toBe(signal.indicators.emaRegime);
      expect(f.adx).toBe(signal.indicators.adx);
      expect(f.regime.state === 'UP').toBe(signal.conditions!.side === 'LONG' ? signal.conditions!.regime.ok : false);
    }
  });

  it('the EMA200 depends on where the window starts — which is why every consumer must cut it the same way', () => {
    const { candles, regimeCandles } = windowsAt(2500);
    const longer = h4.slice(h4.length - (regimeCandles.length + 1));
    expect(buildCandidateFeatures(candles, longer.slice(-WINDOW - 1), params).regime.ema).not.toBe(
      buildCandidateFeatures(candles, regimeCandles, params).regime.ema,
    );
  });
});

describe('shared strategy window (live / backtest / AI)', () => {
  it('is 210 closed candles for EMA200, whether or not the exchange returned the forming candle', () => {
    expect(WINDOW).toBe(210);
    const fetched = h1.slice(0, 212);
    const withForming = [...fetched.slice(0, 211), { ...fetched[211], isClosed: false }];
    expect(lastClosedCandles(withForming, WINDOW)).toEqual(fetched.slice(1, 211));
    expect(lastClosedCandles(fetched, WINDOW)).toEqual(fetched.slice(2, 212));
  });

  it('the AI market snapshot reports the same EMA200/EMAs/RSI/ATR as the strategy on the same window', async () => {
    const i = 2400;
    const { candles, regimeCandles } = windowsAt(i);
    // What the exchange returns for limit = 212: the window plus older candles plus the forming one.
    const forming = { ...h1[i + 1], isClosed: false };
    const regimeEnd = h4.indexOf(regimeCandles[regimeCandles.length - 1]) + 1;
    const gateway = {
      getCandles: jest.fn(({ interval }: { interval: string }) =>
        Promise.resolve(interval === '1h' ? [...h1.slice(i - 210, i + 1), forming] : h4.slice(regimeEnd - 211, regimeEnd)),
      ),
    };
    const tools = new TradingDataTools(
      {} as never, {} as never, {} as never, {} as never, { getAll: () => [] } as never, {} as never,
      new IndicatorsService(), gateway as never, CONFIG as never, {} as never,
    );
    const [snapshot] = tools.get(['get_market_snapshot']);
    const out = (await snapshot.execute({ symbol: 'BTCUSDT' } as never)) as Record<string, unknown> & { regime: Record<string, unknown> };
    const signal = new TrendRegimeStrategy(new IndicatorsService(), CONFIG).onCandleClosed({ symbol: 'BTCUSDT', candles, regimeCandles });

    expect(gateway.getCandles).toHaveBeenCalledWith(expect.objectContaining({ limit: 212 }));
    expect(out.emaFast).toBe(signal.indicators.emaFast);
    expect(out.emaSlow).toBe(signal.indicators.emaSlow);
    expect(out.rsi).toBe(signal.indicators.rsi);
    expect(out.atr).toBe(signal.indicators.atr);
    expect(out.regime.emaRegime).toBe(signal.indicators.emaRegime);
  });
});
