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

    it('charges the real funding when a history is given: positive funding is income for a short', () => {
      const withoutCarry = runShort({}).trades[0];
      const runner = new BacktestRunner(shortStrategy(), new RiskManagerService(PERMISSIVE_RISK_CONFIG), { ...baseParams, feesPct: 0 });
      // One settlement while the short is open (between the candle-6 entry and the candle-7 stop).
      const fundingEvents = [
        { time: 0, rate: 0.5 }, // before the entry: ignored
        { time: 7 * 60_000, rate: 0.001 },
      ];
      const trade = runner.runPortfolio([{ symbol: 'BTCUSDT', candles: DEATH_CROSS, fundingEvents }]).trades[0];
      const notional = trade.entryPrice * trade.qty;
      expect(trade.carryCost).toBeCloseTo(-0.001 * notional);
      expect(trade.pnl).toBeCloseTo(withoutCarry.pnl + 0.001 * notional);
    });
  });

  describe('stop fills', () => {
    it('fills a stop gapped through at the candle open and reports the gap cost', () => {
      // Candle 7 opens at 60, below the ~71.9 stop: a stop-market order fills at 60, not at the stop.
      const gapped = [...GOLDEN_CROSS.slice(0, 7), { ...candle(7, 80, 82, 50), open: 60 }];
      const trade = run({ feesPct: 0 }, gapped).trades[0];
      expect(trade.exitReason).toBe('SL');
      expect(trade.stopLoss).toBeGreaterThan(60);
      expect(trade.exitPrice).toBe(60);
      expect(trade.gapCost).toBeCloseTo((trade.stopLoss - 60) * trade.qty);
      expect(trade.pnl).toBeLessThan(-100);
    });

    it('has no gap cost when the stop is reached inside the candle', () => {
      expect(run({ feesPct: 0 }).trades[0].gapCost).toBe(0);
    });

    it('applies stopSlippagePct to stop exits only', () => {
      const trade = run({ feesPct: 0, slippagePct: 0, stopSlippagePct: 0.01 }).trades[0];
      expect(trade.entryPrice).toBe(90);
      expect(trade.exitPrice).toBeCloseTo(trade.stopLoss * 0.99);
    });
  });

  describe('portfolio mode (runPortfolio: one shared balance)', () => {
    const twoSymbols = (params: Partial<BacktestParams> = {}) =>
      new BacktestRunner(
        new TrendRegimeStrategy(new IndicatorsService(), TINY_STRATEGY_CONFIG),
        new RiskManagerService(PERMISSIVE_RISK_CONFIG),
        { ...baseParams, feesPct: 0, ...params },
      ).runPortfolio([
        { symbol: 'BTCUSDT', candles: GOLDEN_CROSS },
        { symbol: 'ETHUSDT', candles: GOLDEN_CROSS },
      ]);

    it('holds both positions at once on the same balance', () => {
      const result = twoSymbols();
      expect(result.trades.map((t) => t.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
      expect(result.trades[0].qty).toBeCloseTo(result.trades[1].qty);
      expect(Math.max(...result.equityCurve.map((p) => p.openPositions))).toBe(2);
      expect(result.finalBalance).toBeCloseTo(10000 + result.trades.reduce((sum, t) => sum + t.pnl, 0));
    });

    it('shrinks the second same-side entry to fit maxSameSideRiskPct', () => {
      // 1% risk each; a 1.5% cap leaves half a position for the second symbol.
      const result = twoSymbols({ maxSameSideRiskPct: 0.015 });
      const [first, second] = ['BTCUSDT', 'ETHUSDT'].map((s) => result.trades.find((t) => t.symbol === s)!);
      expect(second.qty).toBeCloseTo(first.qty / 2);
    });

    it('vetoes the second entry with AGGREGATE_RISK_LIMIT when the first uses the whole budget', () => {
      const result = twoSymbols({ maxSameSideRiskPct: 0.01 });
      expect(result.trades).toHaveLength(1);
      const vetoed = result.signals.find((sg) => !sg.approved);
      expect(vetoed).toMatchObject({ symbol: 'ETHUSDT', rejectReason: 'AGGREGATE_RISK_LIMIT' });
    });

    it('is exactly the single-symbol run with one symbol', () => {
      const single = run({ feesPct: 0.001 });
      const portfolio = new BacktestRunner(
        new TrendRegimeStrategy(new IndicatorsService(), TINY_STRATEGY_CONFIG),
        new RiskManagerService(PERMISSIVE_RISK_CONFIG),
        { ...baseParams, feesPct: 0.001 },
      ).runPortfolio([{ symbol: 'BTCUSDT', candles: GOLDEN_CROSS }]);
      expect(portfolio).toEqual(single);
    });
  });
});

describe('BacktestRunner consecutive-stops pause', () => {
  // Always wants in; every next candle crashes through the stop: an endless stop-out streak.
  const H = 3_600_000;
  const hourly = (i: number): Candle => ({
    symbol: 'BTCUSDT', interval: '1h', openTime: i * H, open: 100, high: 101, low: i % 2 ? 50 : 99, close: 100,
    volume: 1, closeTime: i * H + H - 1, quoteVolume: 100, trades: 1, isClosed: true,
  });
  const alwaysLong = {
    name: 'AlwaysLong',
    onCandleClosed: (ctx: { candles: Candle[]; symbol: string; openPosition?: unknown }) => {
      const last = ctx.candles[ctx.candles.length - 1];
      return ctx.openPosition
        ? { action: 'NONE' as const, symbol: ctx.symbol, strategy: 'AlwaysLong', candleTime: last.closeTime, price: last.close, indicators: {}, reason: '' }
        : { action: 'ENTER_LONG' as const, symbol: ctx.symbol, strategy: 'AlwaysLong', candleTime: last.closeTime, price: last.close, stopLoss: 95, indicators: {}, reason: '' };
    },
  };

  it('lifts the pause at the next UTC day instead of blocking entries for the rest of the run', () => {
    const candles = Array.from({ length: 72 }, (_, i) => hourly(i)); // 3 days
    const result = new BacktestRunner(alwaysLong, new RiskManagerService({ ...PERMISSIVE_RISK_CONFIG, maxConsecutiveStops: 1 }), {
      strategy: 'AlwaysLong', symbol: 'BTCUSDT', initialBalance: 10_000, feesPct: 0, slippagePct: 0,
    }).run(candles);
    // One stop per day: paused after it, resumed the next day.
    expect(result.trades.map((t) => new Date(t.entryTime).toISOString().slice(0, 10))).toEqual(['1970-01-01', '1970-01-02', '1970-01-03']);
    expect(result.stopPauses).toBe(2);
    expect(result.signals.some((s) => s.rejectReason === 'CONSECUTIVE_STOPS_LIMIT')).toBe(true);
  });
});

describe('BacktestRunner research engine options', () => {
  const H = 3_600_000;
  const bar = (i: number, close: number, low = close - 0.5): Candle => ({
    symbol: 'BTCUSDT', interval: '1h', openTime: i * H, open: close, high: close + 0.5, low, close,
    volume: 1, closeTime: i * H + H - 1, quoteVolume: close, trades: 1, isClosed: true,
  });
  const risk = new RiskManagerService(PERMISSIVE_RISK_CONFIG);
  const params: BacktestParams = { strategy: 'S', symbol: 'BTCUSDT', initialBalance: 10_000, feesPct: 0, slippagePct: 0 };

  /** Enters once at 100 (stop 90), then proposes `trail(close)` as the trailing level every candle. */
  const trailer = (trail: (close: number) => number) => {
    let entered = false;
    return {
      name: 'Trailer',
      onCandleClosed: (ctx: { candles: Candle[]; symbol: string; openPosition?: unknown }) => {
        const last = ctx.candles[ctx.candles.length - 1];
        const base = { symbol: ctx.symbol, strategy: 'Trailer', candleTime: last.closeTime, price: last.close, indicators: {}, reason: '' };
        if (ctx.openPosition) return { ...base, action: 'NONE' as const, trailingStop: trail(last.close) };
        if (entered) return { ...base, action: 'NONE' as const };
        entered = true;
        return { ...base, action: 'ENTER_LONG' as const, stopLoss: 90 };
      },
    };
  };

  it('ratchets the stop up and exits as TRAILING inside the candle that breaks it', () => {
    // Entry 100; closes 104, 108 move the stop to 102, 106; candle 3 dips to 105 → out at 106.
    const candles = [bar(0, 100), bar(1, 104), bar(2, 108), bar(3, 107, 105)];
    const [trade] = new BacktestRunner(trailer((c) => c - 2), risk, params).run(candles).trades;
    expect(trade.exitReason).toBe('TRAILING');
    expect(trade.exitPrice).toBe(106);
    expect(trade.pnl).toBeGreaterThan(0);
    // The trade keeps the stop it was sized on, so R = pnl ÷ planned risk: (106 − 100) ÷ (100 − 90) = 0.6R.
    expect(trade.stopLoss).toBe(90);
  });

  it('never loosens the stop when the proposed level is lower', () => {
    // Candle 2 closes at 103 (level would fall to 101): the stop stays at 102 and candle 3 hits it.
    const candles = [bar(0, 100), bar(1, 104), bar(2, 103, 102.5), bar(3, 103, 101.5)];
    const [trade] = new BacktestRunner(trailer((c) => c - 2), risk, params).run(candles).trades;
    expect(trade.exitPrice).toBe(102);
  });

  it('feeds the strategy regimeLookback regime candles instead of candleLookback', () => {
    const seen: number[] = [];
    const spy = {
      name: 'Spy',
      onCandleClosed: (ctx: { candles: Candle[]; regimeCandles?: Candle[]; symbol: string }) => {
        seen.push(ctx.regimeCandles?.length ?? -1);
        return { action: 'NONE' as const, symbol: ctx.symbol, strategy: 'Spy', candleTime: 0, price: 0, indicators: {}, reason: '' };
      },
    };
    const candles = Array.from({ length: 10 }, (_, i) => bar(i, 100));
    new BacktestRunner(spy, risk, { ...params, candleLookback: 2, regimeLookback: 5 }).run(candles, candles);
    expect(Math.max(...seen)).toBe(5);
    seen.length = 0;
    new BacktestRunner(spy, risk, { ...params, candleLookback: 2 }).run(candles, candles);
    expect(Math.max(...seen)).toBe(2);
  });
});
