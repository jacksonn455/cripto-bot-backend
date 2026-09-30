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

  describe('short side', () => {
    // GOLDEN_CROSS reflected around 100: a death cross at candle 6 (close 110), then candle 7
    // spikes to 150 — far above any plausible short stop, forcing an SL exit.
    const DEATH_CROSS: Candle[] = [
      candle(0, 100, 101, 99),
      candle(1, 105, 106, 104),
      candle(2, 110, 111, 109),
      candle(3, 115, 116, 114),
      candle(4, 120, 121, 119),
      candle(5, 125, 126, 124),
      candle(6, 110, 111, 109),
      candle(7, 120, 150, 118),
    ];
    const shortStrategy = () => new TrendRegimeStrategy(new IndicatorsService(), { ...TINY_STRATEGY_CONFIG, allowShort: 1 });
    const runShort = (params: Partial<BacktestParams>, candles = DEATH_CROSS) =>
      new BacktestRunner(shortStrategy(), new RiskManagerService(PERMISSIVE_RISK_CONFIG), {
        ...baseParams,
        feesPct: 0,
        ...params,
      }).run(candles);

    it('opens a short on the death cross and stops out above, losing exactly risk%', () => {
      const result = runShort({});

      // After the stop-out, candle 7's jump is itself a golden cross in an up regime: a long opens
      // and is closed MANUAL (pnl 0) at the end of data. Only the first trade matters here.
      const [trade] = result.trades;
      expect(result.trades.filter((t) => t.side === 'SHORT')).toHaveLength(1);
      expect(trade.side).toBe('SHORT');
      expect(trade.entryPrice).toBe(110);
      expect(trade.stopLoss).toBeGreaterThan(110);
      expect(trade.exitReason).toBe('SL');
      expect(trade.exitPrice).toBe(trade.stopLoss);
      expect(trade.pnl).toBeCloseTo(-100);
      expect(trade.pnlPct).toBeLessThan(0);
      expect(result.finalBalance).toBeCloseTo(9900);
      expect(result.signals.filter((sg) => sg.action === 'ENTER_SHORT')).toHaveLength(1);
    });

    it('matches the mirrored long trade exactly (same risk, same result)', () => {
      const long = run({ feesPct: 0 }).trades[0];
      const short = runShort({}).trades[0];
      expect(short.qty).toBeCloseTo(long.qty);
      expect(short.pnl).toBeCloseTo(long.pnl);
      expect(short.stopLoss - short.entryPrice).toBeCloseTo(long.entryPrice - long.stopLoss);
    });

    it('books a profit when price falls after the entry (take the stop out of reach)', () => {
      const falling = [...DEATH_CROSS.slice(0, 7), candle(7, 100, 104, 99)];
      const result = runShort({}, falling);
      // Still open at the end of data: closed MANUAL at the last close (100), below the 110 entry.
      const [trade] = result.trades;
      expect(trade.side).toBe('SHORT');
      expect(trade.exitReason).toBe('MANUAL');
      expect(trade.exitPrice).toBe(100);
      expect(trade.pnl).toBeCloseTo((110 - 100) * trade.qty);
      expect(result.finalBalance).toBeCloseTo(10000 + trade.pnl);
    });

    it('marks open shorts to market with the right sign on the equity curve', () => {
      const falling = [...DEATH_CROSS.slice(0, 7), candle(7, 100, 104, 99)];
      const result = runShort({}, falling);
      const last = result.equityCurve[result.equityCurve.length - 1];
      // Price fell 110 -> 100 while short: equity is ABOVE the cash balance.
      expect(last.openPositions).toBe(1);
      expect(last.equity).toBeGreaterThan(last.balance);
    });

    it('applies slippage against the short: sells lower, buys back higher', () => {
      const trade = runShort({ slippagePct: 0.01 }).trades[0];
      expect(trade.entryPrice).toBeCloseTo(110 * 0.99);
      expect(trade.exitPrice).toBeCloseTo(trade.stopLoss * 1.01);
      expect(trade.slippageCost).toBeGreaterThan(0);
    });

    it('charges the short carry cost per day held, inside fees and pnl', () => {
      const withoutCarry = runShort({}).trades[0];
      // Held 1 candle = 60s in this fixture; 100%/day makes the cost visible: notional * 60/86400.
      const withCarry = runShort({ shortBorrowPctPerDay: 1 }).trades[0];
      const expected = withCarry.entryPrice * withCarry.qty * (60_000 / 86_400_000);
      expect(withCarry.carryCost).toBeCloseTo(expected);
      expect(withCarry.fees).toBeCloseTo(expected);
      expect(withCarry.pnl).toBeCloseTo(withoutCarry.pnl - expected);
    });

    it('never charges carry on longs', () => {
      const long = run({ shortBorrowPctPerDay: 1 }).trades[0];
      expect(long.side).toBe('LONG');
      expect(long.carryCost).toBe(0);
    });

    it('does not short at all with the default allowShort=0 (baseline stays long-only)', () => {
      const baseline = new BacktestRunner(
        new TrendRegimeStrategy(new IndicatorsService(), TINY_STRATEGY_CONFIG),
        new RiskManagerService(PERMISSIVE_RISK_CONFIG),
        { ...baseParams, feesPct: 0 },
      ).run(DEATH_CROSS);
      expect(baseline.trades.filter((t) => t.side === 'SHORT')).toHaveLength(0);
      expect(baseline.signals.some((sg) => sg.action === 'ENTER_SHORT')).toBe(false);
    });
  });
});
