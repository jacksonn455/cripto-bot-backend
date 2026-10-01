import { RiskManagerService } from './risk-manager.service';
import { RiskContext } from './risk.interface';
import type { Signal } from '../strategy/strategy.interface';

const DEFAULT_CONFIG = {
  riskPerTradePct: 0.01,
  maxOpenPositions: 3,
  maxExposurePerAssetPct: 0.3,
  maxTotalExposurePct: 0.6,
  maxDailyLossPct: 0.03,
  maxConsecutiveStops: 3,
  minRiskRewardRatio: 1.5,
  minVolume24h: 0,
  maxSpreadPct: 100,
};

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    action: 'ENTER_LONG',
    symbol: 'BTCUSDT',
    strategy: 'TrendRegimeStrategy',
    candleTime: Date.now(),
    price: 100,
    stopLoss: 95,
    takeProfit: 110,
    indicators: {},
    reason: 'test',
    ...overrides,
  };
}

function makeContext(overrides: Partial<RiskContext> = {}): RiskContext {
  return {
    accountEquity: 10000,
    openPositionsCount: 0,
    currentExposureByAsset: {},
    totalExposure: 0,
    dailyPnl: 0,
    consecutiveStopLosses: 0,
    isPaused: false,
    reconciliationOk: true,
    ...overrides,
  };
}

describe('RiskManagerService', () => {
  const risk = new RiskManagerService(DEFAULT_CONFIG);

  it('approves a valid signal and sizes qty from risk% and stop distance', () => {
    const decision = risk.evaluate(makeSignal(), makeContext());
    // riskAmount = 10000*0.01=100; riskPerUnit = 100-95=5; qty = 100/5 = 20
    expect(decision).toEqual({ approved: true, qty: 20 });
  });

  it('lets non-entry signals (EXIT/NONE) pass through without evaluation', () => {
    expect(risk.evaluate(makeSignal({ action: 'EXIT' }), makeContext({ isPaused: true }))).toEqual({
      approved: true,
    });
    expect(risk.evaluate(makeSignal({ action: 'NONE' }), makeContext({ isPaused: true }))).toEqual({
      approved: true,
    });
  });

  it('vetoes when the bot is paused', () => {
    const decision = risk.evaluate(makeSignal(), makeContext({ isPaused: true }));
    expect(decision).toEqual({ approved: false, rejectReason: 'BOT_PAUSED' });
  });

  it('vetoes when reconciliation has not succeeded', () => {
    const decision = risk.evaluate(makeSignal(), makeContext({ reconciliationOk: false }));
    expect(decision).toEqual({ approved: false, rejectReason: 'RECONCILIATION_FAILED' });
  });

  it('vetoes when the daily loss limit has been hit', () => {
    const decision = risk.evaluate(makeSignal(), makeContext({ dailyPnl: -300 }));
    expect(decision).toEqual({ approved: false, rejectReason: 'DAILY_LOSS_LIMIT' });
  });

  it('vetoes after too many consecutive stop losses', () => {
    const decision = risk.evaluate(makeSignal(), makeContext({ consecutiveStopLosses: 3 }));
    expect(decision).toEqual({ approved: false, rejectReason: 'CONSECUTIVE_STOPS_LIMIT' });
  });

  it('vetoes when the max open positions limit is reached', () => {
    const decision = risk.evaluate(makeSignal(), makeContext({ openPositionsCount: 3 }));
    expect(decision).toEqual({ approved: false, rejectReason: 'MAX_OPEN_POSITIONS' });
  });

  it('vetoes an entry with no stop loss', () => {
    const decision = risk.evaluate(makeSignal({ stopLoss: undefined }), makeContext());
    expect(decision).toEqual({ approved: false, rejectReason: 'MISSING_STOP_LOSS' });
  });

  it('vetoes when the stop is at the same price as entry', () => {
    const decision = risk.evaluate(makeSignal({ stopLoss: 100 }), makeContext());
    expect(decision).toEqual({ approved: false, rejectReason: 'INVALID_STOP_DISTANCE' });
  });

  it('vetoes when the risk/reward ratio is below the minimum', () => {
    const decision = risk.evaluate(makeSignal({ takeProfit: 104 }), makeContext());
    expect(decision).toEqual({ approved: false, rejectReason: 'RR_TOO_LOW' });
  });

  it('vetoes on low 24h liquidity', () => {
    const strict = new RiskManagerService({ ...DEFAULT_CONFIG, minVolume24h: 1_000_000 });
    const decision = strict.evaluate(
      makeSignal(),
      makeContext({ symbolLiquidity: { volume24h: 1000, spreadPct: 0.1 } }),
    );
    expect(decision).toEqual({ approved: false, rejectReason: 'LOW_LIQUIDITY' });
  });

  it('vetoes on spread too wide', () => {
    const strict = new RiskManagerService({ ...DEFAULT_CONFIG, maxSpreadPct: 0.5 });
    const decision = strict.evaluate(
      makeSignal(),
      makeContext({ symbolLiquidity: { volume24h: 1_000_000, spreadPct: 1 } }),
    );
    expect(decision).toEqual({ approved: false, rejectReason: 'SPREAD_TOO_WIDE' });
  });

  it('vetoes when per-asset exposure is already maxed out', () => {
    const decision = risk.evaluate(
      makeSignal(),
      makeContext({ currentExposureByAsset: { BTCUSDT: 3000 } }), // == maxExposurePerAssetPct * equity
    );
    expect(decision).toEqual({ approved: false, rejectReason: 'MAX_EXPOSURE_EXCEEDED' });
  });

  it('vetoes when total exposure is already maxed out', () => {
    const decision = risk.evaluate(makeSignal(), makeContext({ totalExposure: 6000 }));
    expect(decision).toEqual({ approved: false, rejectReason: 'MAX_EXPOSURE_EXCEEDED' });
  });

  it('caps qty to the remaining allowed per-asset exposure instead of rejecting outright', () => {
    // remaining = 3000 - 2500 = 500 notional; qty = 500/100 = 5 (< the 20 risk% would size)
    const decision = risk.evaluate(
      makeSignal(),
      makeContext({ currentExposureByAsset: { BTCUSDT: 2500 } }),
    );
    expect(decision).toEqual({ approved: true, qty: 5 });
  });

  it('rounds qty down to the LOT_SIZE step and rejects if below minQty', () => {
    const decision = risk.evaluate(
      makeSignal(),
      makeContext({
        symbolFilters: {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          status: 'TRADING',
          minQty: 50,
          maxQty: 1000,
          stepSize: 1,
          minPrice: 0,
          maxPrice: 1_000_000,
          tickSize: 0.01,
          minNotional: 0,
        },
      }),
    );
    expect(decision).toEqual({ approved: false, rejectReason: 'LOT_SIZE_TOO_SMALL' });
  });

  it('rejects if the rounded qty fails MIN_NOTIONAL', () => {
    const decision = risk.evaluate(
      makeSignal(),
      makeContext({
        symbolFilters: {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          status: 'TRADING',
          minQty: 0,
          maxQty: 1000,
          stepSize: 1,
          minPrice: 0,
          maxPrice: 1_000_000,
          tickSize: 0.01,
          minNotional: 100_000,
        },
      }),
    );
    expect(decision).toEqual({ approved: false, rejectReason: 'MIN_NOTIONAL_NOT_MET' });
  });

  describe('short entries', () => {
    const shortSignal = (overrides: Partial<Signal> = {}) =>
      makeSignal({ action: 'ENTER_SHORT', price: 100, stopLoss: 105, takeProfit: 90, ...overrides });

    it('approves a valid short and sizes qty from the distance to a stop ABOVE the entry', () => {
      const decision = risk.evaluate(shortSignal(), makeContext({ shortSellingSupported: true }));
      // riskAmount = 100; riskPerUnit = 105 - 100 = 5; qty = 20, same as the mirrored long.
      expect(decision).toEqual({ approved: true, qty: 20 });
    });

    it('rejects shorts on a venue that cannot short (Binance Spot) instead of sending a naked SELL', () => {
      expect(risk.evaluate(shortSignal(), makeContext())).toEqual({ approved: false, rejectReason: 'SHORT_NOT_SUPPORTED' });
      expect(risk.evaluate(shortSignal(), makeContext({ shortSellingSupported: false }))).toEqual({
        approved: false,
        rejectReason: 'SHORT_NOT_SUPPORTED',
      });
    });

    it('rejects a short whose stop is below the entry (it would never cap the loss)', () => {
      const decision = risk.evaluate(shortSignal({ stopLoss: 95 }), makeContext({ shortSellingSupported: true }));
      expect(decision).toEqual({ approved: false, rejectReason: 'INVALID_STOP_DISTANCE' });
    });

    it('rejects a short whose take profit is above the entry', () => {
      const decision = risk.evaluate(shortSignal({ takeProfit: 110 }), makeContext({ shortSellingSupported: true }));
      expect(decision).toEqual({ approved: false, rejectReason: 'INVALID_TAKE_PROFIT' });
    });

    it('applies the same R:R rule as longs', () => {
      // reward 5 / risk 5 = 1 < 1.5
      const decision = risk.evaluate(shortSignal({ takeProfit: 95 }), makeContext({ shortSellingSupported: true }));
      expect(decision).toEqual({ approved: false, rejectReason: 'RR_TOO_LOW' });
    });

    it('caps short notional by the per-asset exposure limit, like longs', () => {
      // riskPerUnit 0.5 -> qty 200 (notional 20k) capped to 30% of 10k = 3000 -> qty 30.
      const decision = risk.evaluate(
        shortSignal({ stopLoss: 100.5, takeProfit: 90 }),
        makeContext({ shortSellingSupported: true }),
      );
      expect(decision).toEqual({ approved: true, qty: 30 });
    });

    it('still honors pause and daily-loss vetoes', () => {
      expect(risk.evaluate(shortSignal(), makeContext({ isPaused: true, shortSellingSupported: true })).rejectReason).toBe(
        'BOT_PAUSED',
      );
      expect(
        risk.evaluate(shortSignal(), makeContext({ dailyPnl: -300, shortSellingSupported: true })).rejectReason,
      ).toBe('DAILY_LOSS_LIMIT');
    });
  });

  it('rejects a long whose stop is above the entry (previously accepted via Math.abs)', () => {
    expect(risk.evaluate(makeSignal({ stopLoss: 105 }), makeContext())).toEqual({
      approved: false,
      rejectReason: 'INVALID_STOP_DISTANCE',
    });
  });

  it('rejects a long whose take profit is below the entry', () => {
    expect(risk.evaluate(makeSignal({ takeProfit: 90 }), makeContext())).toEqual({
      approved: false,
      rejectReason: 'INVALID_TAKE_PROFIT',
    });
  });
});

describe('RiskManagerService same-side aggregate risk cap (maxSameSideRiskPct)', () => {
  const risk = new RiskManagerService({ ...DEFAULT_CONFIG, minRiskRewardRatio: 0 });
  const signal = makeSignal({ takeProfit: undefined }); // risk 100 → qty 20 at a 5 stop distance

  it('does nothing without the cap (production default)', () => {
    expect(risk.evaluate(signal, makeContext({ openRiskBySide: { LONG: 1000, SHORT: 0 } }))).toEqual({ approved: true, qty: 20 });
  });

  it('shrinks the entry to what is left of the budget', () => {
    // Budget 1.5% of 10000 = 150; 100 already at risk on longs → 50 left → qty 10.
    const decision = risk.evaluate(signal, makeContext({ maxSameSideRiskPct: 0.015, openRiskBySide: { LONG: 100, SHORT: 0 } }));
    expect(decision.approved).toBe(true);
    expect(decision.qty).toBeCloseTo(10);
  });

  it('vetoes with AGGREGATE_RISK_LIMIT once the side is full', () => {
    expect(risk.evaluate(signal, makeContext({ maxSameSideRiskPct: 0.015, openRiskBySide: { LONG: 150, SHORT: 0 } }))).toEqual({
      approved: false,
      rejectReason: 'AGGREGATE_RISK_LIMIT',
    });
  });

  it('only counts the same side: open shorts do not limit a long', () => {
    expect(
      risk.evaluate(signal, makeContext({ maxSameSideRiskPct: 0.015, openRiskBySide: { LONG: 0, SHORT: 150 } })),
    ).toEqual({ approved: true, qty: 20 });
  });
});
