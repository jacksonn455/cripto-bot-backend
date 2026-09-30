import { Candle } from '../exchange/types/candle.type';
import { IndicatorsService } from '../indicators/indicators.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { TrendRegimeStrategy } from '../strategy/trend-regime.strategy';
import { BacktestRunner } from './backtest-runner';
import { BacktestParams } from './backtest.types';

function candle(index: number, close: number, high: number, low: number): Candle {
  return {
    symbol: 'BTCUSDT',
    interval: '1h',
    openTime: index * 60_000,
    open: close,
    high,
    low,
    close,
    volume: 100,
    closeTime: index * 60_000 + 59_999,
    quoteVolume: 100 * close,
    trades: 10,
    isClosed: true,
  };
}

const TINY_STRATEGY_CONFIG = {
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

const PERMISSIVE_RISK_CONFIG = {
  riskPerTradePct: 0.01,
  maxOpenPositions: 3,
  maxExposurePerAssetPct: 1,
  maxTotalExposurePct: 1,
  maxDailyLossPct: 1,
  maxConsecutiveStops: 10,
  minRiskRewardRatio: 0,
  minVolume24h: 0,
  maxSpreadPct: 100,
};

describe('BacktestRunner', () => {
  it('enters on the golden cross and exits on the stop, with pnl matching risk% exactly', () => {
    // Same hand-verified golden-cross setup as the TrendRegimeStrategy spec: ENTER_LONG at
    // close=90 (index6). Candle 7's low (50) is far below any plausible stop, forcing an SL exit.
    const candles: Candle[] = [
      candle(0, 100, 101, 99),
      candle(1, 95, 96, 94),
      candle(2, 90, 91, 89),
      candle(3, 85, 86, 84),
      candle(4, 80, 81, 79),
      candle(5, 75, 76, 74),
      candle(6, 90, 91, 89),
      candle(7, 80, 82, 50),
    ];

    const strategy = new TrendRegimeStrategy(new IndicatorsService(), TINY_STRATEGY_CONFIG);
    const riskManager = new RiskManagerService(PERMISSIVE_RISK_CONFIG);
    const params: BacktestParams = {
      strategy: 'TrendRegimeStrategy',
      symbol: 'BTCUSDT',
      initialBalance: 10000,
      feesPct: 0,
      slippagePct: 0,
    };

    const result = new BacktestRunner(strategy, riskManager, params).run(candles);

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.entryPrice).toBe(90);
    expect(trade.exitReason).toBe('SL');
    expect(trade.exitPrice).toBe(trade.stopLoss);
    // With no fees/slippage, a stop-out always loses exactly riskAmount = equity * riskPerTradePct.
    expect(trade.pnl).toBeCloseTo(-100);
    expect(result.finalBalance).toBeCloseTo(9900);

    const entrySignals = result.signals.filter((s) => s.action === 'ENTER_LONG');
    expect(entrySignals).toHaveLength(1);
    expect(entrySignals[0].approved).toBe(true);
  });

  it('never evaluates a candle that is not closed', () => {
    const candles: Candle[] = [
      candle(0, 100, 101, 99),
      candle(1, 95, 96, 94),
      { ...candle(2, 90, 91, 89), isClosed: false },
    ];
    const strategy = new TrendRegimeStrategy(new IndicatorsService(), TINY_STRATEGY_CONFIG);
    const riskManager = new RiskManagerService(PERMISSIVE_RISK_CONFIG);
    const params: BacktestParams = {
      strategy: 'TrendRegimeStrategy',
      symbol: 'BTCUSDT',
      initialBalance: 10000,
      feesPct: 0,
      slippagePct: 0,
    };

    const result = new BacktestRunner(strategy, riskManager, params).run(candles);

    // Only the 2 closed candles produce equity points; the unclosed one is dropped entirely.
    expect(result.equityCurve).toHaveLength(2);
  });

  const GOLDEN_CROSS: Candle[] = [
    candle(0, 100, 101, 99),
    candle(1, 95, 96, 94),
    candle(2, 90, 91, 89),
    candle(3, 85, 86, 84),
    candle(4, 80, 81, 79),
    candle(5, 75, 76, 74),
    candle(6, 90, 91, 89),
    candle(7, 80, 82, 50),
  ];
  const baseParams: BacktestParams = {
    strategy: 'TrendRegimeStrategy',
    symbol: 'BTCUSDT',
    initialBalance: 10000,
    feesPct: 0.001,
    slippagePct: 0,
  };
  const run = (params: Partial<BacktestParams>, candles = GOLDEN_CROSS, regime?: Candle[]) =>
    new BacktestRunner(
      new TrendRegimeStrategy(new IndicatorsService(), TINY_STRATEGY_CONFIG),
      new RiskManagerService(PERMISSIVE_RISK_CONFIG),
      { ...baseParams, ...params },
    ).run(candles, regime);

  it('charges each fee once: final balance = initial + sum of trade pnl (fees included)', () => {
    const result = run({});
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].fees).toBeGreaterThan(0);
    const sumPnl = result.trades.reduce((s, t) => s + t.pnl, 0);
    expect(result.finalBalance).toBeCloseTo(10000 + sumPnl, 8);
  });

  it('uses only regime candles already closed at each step (no lookahead)', () => {
    // Regime "4h" candles: the one closing after the entry candle is a crash that would veto
    // the regime if it leaked into the past. It must not.
    const regimeUp = [candle(0, 10, 11, 9), candle(1, 20, 21, 19), candle(2, 30, 31, 29), candle(3, 40, 41, 39), candle(6, 200, 201, 199)];
    const crashLater = { ...candle(7, 1, 2, 0.5) };
    const withFuture = run({ feesPct: 0 }, GOLDEN_CROSS, [...regimeUp, crashLater]);
    const withoutFuture = run({ feesPct: 0 }, GOLDEN_CROSS, regimeUp);
    expect(withFuture.trades.map((t) => t.entryTime)).toEqual(withoutFuture.trades.map((t) => t.entryTime));
    expect(withFuture.trades).toHaveLength(1);
  });

  it('does not enter while no regime candle has closed yet', () => {
    const regimeOnlyInFuture = [candle(100, 10, 11, 9)];
    expect(run({ feesPct: 0 }, GOLDEN_CROSS, regimeOnlyInFuture).trades).toHaveLength(0);
  });

  it('treats candles before tradeFrom as warm-up only (indicators, no trades, no equity points)', () => {
    const tradeFrom = GOLDEN_CROSS[6].closeTime; // warm-up = candles 0..5
    const result = run({ feesPct: 0, tradeFrom });
    expect(result.equityCurve.map((p) => p.timestamp)).toEqual([GOLDEN_CROSS[6].closeTime, GOLDEN_CROSS[7].closeTime]);
    // The cross at candle 6 is still detected thanks to the warm-up history.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryTime).toBe(GOLDEN_CROSS[6].closeTime);
  });

  it('limits the strategy window to candleLookback candles, like the live loop', () => {
    const seen: number[] = [];
    const spy = {
      name: 'Spy',
      onCandleClosed: (ctx: { candles: Candle[]; symbol: string }) => {
        seen.push(ctx.candles.length);
        return { action: 'NONE' as const, symbol: ctx.symbol, strategy: 'Spy', candleTime: 0, price: 0, indicators: {}, reason: '' };
      },
    };
    new BacktestRunner(spy, new RiskManagerService(PERMISSIVE_RISK_CONFIG), { ...baseParams, candleLookback: 3 }).run(GOLDEN_CROSS);
    expect(seen).toEqual([1, 2, 3, 3, 3, 3, 3, 3]);
  });
});
