import { BacktestRunner } from '../backtest/backtest-runner';
import type { BacktestParams, SymbolSeries } from '../backtest/backtest.types';
import { IndicatorsService } from '../indicators/indicators.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { strategyWindowSize } from '../strategy/strategy-window';
import { TrendRegimeStrategy } from '../strategy/trend-regime.strategy';
import { simulateShadowOutcome } from './shadow-outcome';
import { aggregateCandles, syntheticCandles } from './testing/synthetic-candles';

const BASE = {
  symbols: ['BTCUSDT'], timeframe: '1h', regimeTimeframe: '4h', emaFast: 20, emaSlow: 50, emaRegime: 200,
  rsiPeriod: 14, rsiMin: 45, rsiMax: 70, atrPeriod: 14, atrStopMultiplier: 2, chandelierLookback: 22, chandelierAtrMultiplier: 3,
};
const RISK = {
  riskPerTradePct: 0.01, maxOpenPositions: 3, maxExposurePerAssetPct: 0.3, maxTotalExposurePct: 0.6, maxDailyLossPct: 0.03,
  maxConsecutiveStops: 3, minRiskRewardRatio: 1.5, minVolume24h: 0, maxSpreadPct: 100,
};
const W = strategyWindowSize(200);
const COSTS = { feesPct: 0.001, slippagePct: 0.0005, stopSlippagePct: 0.001, shortBorrowPctPerDay: 0.0003 };

function setup(seed: number, extra: Record<string, number>) {
  const h1 = syntheticCandles({ count: 3500, seed });
  const series: SymbolSeries = { symbol: 'BTCUSDT', candles: h1, regimeCandles: aggregateCandles(h1, 4) };
  const strategy = new TrendRegimeStrategy(new IndicatorsService(), { ...BASE, ...extra });
  const params: BacktestParams = {
    strategy: 'TrendRegimeStrategy', symbol: 'BTCUSDT', initialBalance: 10_000, ...COSTS, candleLookback: W, tradeFrom: h1[W + 300].closeTime,
  };
  const run = (recordCandidates: boolean) =>
    new BacktestRunner(strategy, new RiskManagerService(RISK as never), { ...params, recordCandidates }).runPortfolio([series]);
  return { series, strategy, run };
}

describe.each([
  ['default exits (cross back / chandelier on close)', 21, { allowShort: 1 }],
  ['since-entry trailing stop', 22, { allowShort: 1, trailingMode: 1 }],
])('candidate infrastructure vs BacktestRunner — %s', (_name, seed, extra) => {
  const { series, strategy, run } = setup(seed, extra);
  const off = run(false);
  const on = run(true);

  it('recording candidates changes nothing in the simulation', () => {
    expect(off.candidates).toBeUndefined();
    expect(on.trades).toEqual(off.trades);
    expect(on.signals).toEqual(off.signals);
    expect(on.equityCurve).toEqual(off.equityCurve);
    expect(on.finalBalance).toBe(off.finalBalance);
  });

  it('the ledger holds rejected candidates too, and exactly one ENTERED row per trade', () => {
    const candidates = on.candidates!;
    expect(candidates.filter((c) => c.finalAction === 'ENTERED').map((c) => c.candleCloseTime)).toEqual(on.trades.map((t) => t.entryTime));
    expect(candidates.filter((c) => c.finalAction === 'REJECTED').length).toBeGreaterThan(0);
    expect(new Set(candidates.map((c) => c.candidateId)).size).toBe(candidates.length);
  });

  it('the shadow outcome of each traded candidate reproduces the backtest trade (exit time, reason, price, R)', () => {
    const entered = on.candidates!.filter((c) => c.finalAction === 'ENTERED');
    let compared = 0;
    for (const c of entered) {
      const trade = on.trades.find((t) => t.entryTime === c.candleCloseTime)!;
      const shadow = simulateShadowOutcome({
        strategy, symbol: 'BTCUSDT', side: c.side, price: c.price, stopLoss: c.stopLoss!, candleCloseTime: c.candleCloseTime,
        candles: series.candles, regimeCandles: series.regimeCandles, windowSize: W, costs: COSTS,
      })!;
      if (trade.exitReason === 'MANUAL') {
        // The backtest force-closes at the end of the data; the shadow just reports it still open.
        expect(shadow.status).toBe('OPEN');
        continue;
      }
      compared++;
      expect(shadow.status).toBe('CLOSED');
      expect(shadow.exitTime).toBe(trade.exitTime);
      expect(shadow.exitReason).toBe(trade.exitReason);
      expect(shadow.exitPrice).toBeCloseTo(trade.exitPrice, 9);
      const tradeR = trade.pnl / (Math.abs(trade.entryPrice - trade.stopLoss) * trade.qty);
      expect(shadow.r).toBeCloseTo(tradeR, 9);
    }
    expect(compared).toBeGreaterThan(5);
  });

  it('rejected candidates get a shadow outcome too — without any order or balance', () => {
    const rejected = on.candidates!.filter((c) => c.finalAction === 'REJECTED' && c.stopLoss !== undefined).slice(0, 10);
    for (const c of rejected) {
      const shadow = simulateShadowOutcome({
        strategy, symbol: 'BTCUSDT', side: c.side, price: c.price, stopLoss: c.stopLoss!, candleCloseTime: c.candleCloseTime,
        candles: series.candles, regimeCandles: series.regimeCandles, windowSize: W,
      });
      expect(shadow).not.toBeNull();
      expect(['WIN', 'LOSS', 'OPEN']).toContain(shadow!.outcome);
    }
  });
});

describe('simulateShadowOutcome edge cases', () => {
  const h1 = syntheticCandles({ count: 400, seed: 5 });
  const strategy = new TrendRegimeStrategy(new IndicatorsService(), BASE);
  const at = h1[300];

  it('a stop hit inside the next candle exits as SL at the stop (≈ −1R net of costs)', () => {
    const next = h1[301];
    const out = simulateShadowOutcome({
      strategy, symbol: 'BTCUSDT', side: 'LONG', price: at.close, stopLoss: Math.min(next.low, next.open) + 1e-9, candleCloseTime: at.closeTime,
      candles: h1, windowSize: W, costs: { feesPct: 0, slippagePct: 0, stopSlippagePct: 0, shortBorrowPctPerDay: 0 },
    })!;
    expect(out).toMatchObject({ status: 'CLOSED', exitReason: 'SL', outcome: 'LOSS', barsHeld: 1 });
    expect(out.r).toBeLessThanOrEqual(-1 + 1e-6);
  });

  it('unknown candle or zero risk → null; maxBars caps the horizon as OPEN', () => {
    const base = { strategy, symbol: 'BTCUSDT', side: 'LONG' as const, price: at.close, candles: h1, windowSize: W };
    expect(simulateShadowOutcome({ ...base, stopLoss: at.close * 0.9, candleCloseTime: 42 })).toBeNull();
    expect(simulateShadowOutcome({ ...base, stopLoss: at.close * (1 + 0.0005), candleCloseTime: at.closeTime })).toBeNull();
    const capped = simulateShadowOutcome({ ...base, stopLoss: at.close * 0.5, candleCloseTime: at.closeTime, maxBars: 3 })!;
    expect(capped).toMatchObject({ status: 'OPEN', outcome: 'OPEN', barsHeld: 3 });
  });
});
