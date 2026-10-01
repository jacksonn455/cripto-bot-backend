import { InMemoryEvaluationSnapshotStore } from '../control/evaluation-snapshot.store';
import { TradesService } from '../trades/trades.service';
import { Candle } from '../exchange/types/candle.type';
import { InMemoryEvaluationCheckpointStore } from './evaluation-checkpoint.store';
import { ExecutionService, MarketDataError } from './execution.service';

function candle(closeTime: number, close: number, high: number, low: number): Candle {
  return {
    symbol: 'BTCUSDT',
    interval: '1h',
    openTime: closeTime - 3_600_000,
    open: close,
    high,
    low,
    close,
    volume: 100,
    closeTime,
    quoteVolume: 100 * close,
    trades: 10,
    isClosed: true,
  };
}

const TRADING_CONFIG = { mode: 'PAPER' as const };
const STRATEGY_CONFIG = {
  timeframe: '1h',
  regimeTimeframe: '1h',
  emaRegime: 10,
  symbols: ['BTCUSDT'],
};
const EXECUTION_CONFIG = { stopLimitOffsetPct: 0.001, enabled: true, pollIntervalSeconds: 60, reconciliationIntervalMinutes: 15 };

function makeDeps(overrides: {
  signal?: unknown;
  decision?: unknown;
  openTrade?: unknown;
  candles?: Candle[];
  fillPrice?: number;
  checkpoints?: InMemoryEvaluationCheckpointStore;
  snapshots?: InMemoryEvaluationSnapshotStore;
} = {}) {
  const candles = overrides.candles ?? [candle(1_000, 100, 101, 99)];
  const signal = overrides.signal ?? {
    action: 'ENTER_LONG',
    symbol: 'BTCUSDT',
    strategy: 'TrendRegimeStrategy',
    candleTime: candles[candles.length - 1].closeTime,
    price: 100,
    stopLoss: 90,
    indicators: {},
    reason: 'test',
  };
  const decision = overrides.decision ?? { approved: true, qty: 1 };

  const gateway = {
    kind: 'PAPER' as const,
    getCandles: jest.fn().mockResolvedValue(candles),
    placeOrder: jest.fn().mockResolvedValue({
      symbol: 'BTCUSDT',
      orderId: '1',
      clientOrderId: 'x',
      side: 'BUY',
      type: 'MARKET',
      status: 'FILLED',
      price: overrides.fillPrice ?? 100,
      origQty: 1,
      executedQty: 1,
      createdAt: Date.now(),
    }),
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  };

  const strategy = { name: 'TrendRegimeStrategy', onCandleClosed: jest.fn().mockReturnValue(signal) };
  const strategyRegistry = { get: jest.fn().mockReturnValue(strategy) };
  const riskManager = { evaluate: jest.fn().mockReturnValue(decision) };
  const riskContextBuilder = { build: jest.fn().mockResolvedValue({}) };
  const signalsService = { record: jest.fn().mockResolvedValue(undefined) };
  const tradesService = {
    findOpenPosition: jest.fn().mockResolvedValue(overrides.openTrade ?? null),
    openPosition: jest.fn().mockResolvedValue({ _id: 'trade1', entryPrice: 100 }),
    closePosition: jest.fn().mockResolvedValue(undefined),
    // Real settlement math on top of the mocked persistence.
    settlePosition(...args: Parameters<TradesService['settlePosition']>) {
      return TradesService.prototype.settlePosition.apply(this as never, args);
    },
  };
  const ordersService = {
    create: jest.fn().mockResolvedValue(undefined),
    findByTradeId: jest.fn().mockResolvedValue([]),
  };
  const reconciliation = { isOk: jest.fn().mockReturnValue(true) };
  const controlService = { checkAutoPauseConditions: jest.fn().mockResolvedValue(undefined) };
  const runtimeStatus = {
    recordCycle: jest.fn(),
    recordError: jest.fn(),
    getLastCycleAgoLabel: jest.fn().mockReturnValue('0s ago'),
  };
  const eventEmitter = { emit: jest.fn() };
  const riskConfigValues = { maxDailyLossPct: 0.03, maxConsecutiveStops: 3 };
  const checkpoints = overrides.checkpoints ?? new InMemoryEvaluationCheckpointStore();
  const snapshots = overrides.snapshots ?? new InMemoryEvaluationSnapshotStore();

  const service = new ExecutionService(
    gateway as never,
    strategyRegistry as never,
    riskManager as never,
    riskContextBuilder as never,
    signalsService as never,
    tradesService as never,
    ordersService as never,
    reconciliation as never,
    controlService as never,
    runtimeStatus as never,
    eventEmitter as never,
    TRADING_CONFIG as never,
    STRATEGY_CONFIG as never,
    EXECUTION_CONFIG as never,
    riskConfigValues as never,
    checkpoints,
    snapshots,
  );

  return {
    service,
    checkpoints,
    snapshots,
    gateway,
    strategy,
    riskManager,
    riskContextBuilder,
    signalsService,
    tradesService,
    ordersService,
    eventEmitter,
  };
}

describe('ExecutionService (PAPER mode)', () => {
  it('enters a position when the strategy signals and risk approves', async () => {
    const { service, gateway, tradesService, ordersService, signalsService } = makeDeps();

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'BUY', type: 'MARKET', quantity: 1 }),
    );
    expect(tradesService.openPosition).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', stopLoss: 90, status: 'OPEN' }),
    );
    expect(ordersService.create).toHaveBeenCalledTimes(1);
    expect(signalsService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ENTER_LONG' }),
      expect.objectContaining({ approved: true }),
      'PAPER',
    );
  });

  it('does not enter when the risk manager rejects the signal', async () => {
    const { service, gateway, tradesService, signalsService } = makeDeps({
      decision: { approved: false, rejectReason: 'MAX_OPEN_POSITIONS' },
    });

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(tradesService.openPosition).not.toHaveBeenCalled();
    expect(signalsService.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approved: false }),
      'PAPER',
    );
  });

  it('closes an open PAPER position via the conservative intra-candle stop rule', async () => {
    // Opens above the stop (95) and trades down through it: low(70) breaches stopLoss(90).
    const candles = [{ ...candle(2_000, 80, 85, 70), open: 95 }];
    const openTrade = {
      _id: 'trade1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice: 100,
      qty: 1,
      stopLoss: 90,
      takeProfit: undefined,
    };
    const { service, gateway, tradesService } = makeDeps({
      candles,
      openTrade,
      signal: { action: 'NONE', symbol: 'BTCUSDT', strategy: 'TrendRegimeStrategy', candleTime: 2_000, price: 80, indicators: {}, reason: 'n/a' },
    });

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(tradesService.closePosition).toHaveBeenCalledWith(
      'trade1',
      expect.objectContaining({ exitPrice: 90, exitReason: 'SL' }),
    );
    expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
  });

  it('dedupes repeated cycles for the same closed candle', async () => {
    const { service, gateway } = makeDeps();

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');
    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
  });

  describe('short trades', () => {
    const shortSignal = {
      action: 'ENTER_SHORT',
      symbol: 'BTCUSDT',
      strategy: 'TrendRegimeStrategy',
      candleTime: 1_000,
      price: 100,
      stopLoss: 110,
      indicators: {},
      reason: 'death cross',
    };
    const openShort = {
      _id: 'trade2',
      symbol: 'BTCUSDT',
      side: 'SHORT',
      mode: 'PAPER',
      strategy: 'TrendRegimeStrategy',
      timeframe: '1h',
      entryPrice: 100,
      qty: 2,
      stopLoss: 110,
      takeProfit: undefined,
      entryTime: new Date(0),
    };

    it('opens a short with a SELL and persists side=SHORT', async () => {
      const { service, gateway, tradesService, ordersService, eventEmitter } = makeDeps({ signal: shortSignal });

      await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

      expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL', type: 'MARKET', quantity: 1 }));
      expect(tradesService.openPosition).toHaveBeenCalledWith(
        expect.objectContaining({ side: 'SHORT', stopLoss: 110, timeframe: '1h', entryReason: 'death cross' }),
      );
      expect(ordersService.create).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'trade.opened',
        expect.objectContaining({ side: 'SHORT', symbol: 'BTCUSDT', entryPrice: 100, strategy: 'TrendRegimeStrategy', timeframe: '1h' }),
      );
    });

    it('stops out a short when the candle HIGH reaches the stop, buying back with a BUY', async () => {
      const { service, gateway, tradesService, eventEmitter } = makeDeps({
        candles: [candle(2_000, 108, 111, 105)], // high 111 >= stop 110
        openTrade: openShort,
        signal: { ...shortSignal, action: 'NONE' },
      });

      await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

      expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
      // Short loses when price rises: (100 - 110) * 2 = -20, -10%.
      expect(tradesService.closePosition).toHaveBeenCalledWith(
        'trade2',
        expect.objectContaining({ exitPrice: 110, exitReason: 'SL', pnl: -20, pnlPct: -10 }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'trade.closed',
        expect.objectContaining({ side: 'SHORT', reason: 'SL', pnl: -20, entryPrice: 100, exitPrice: 110, qty: 2 }),
      );
    });

    it('does not stop out a short on a low below the stop (profitable direction)', async () => {
      const { service, tradesService } = makeDeps({
        candles: [candle(2_000, 90, 95, 85)],
        openTrade: openShort,
        signal: { ...shortSignal, action: 'NONE' },
      });

      await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

      expect(tradesService.closePosition).not.toHaveBeenCalled();
    });

    it('exits a short on the strategy EXIT signal with a positive pnl when price fell', async () => {
      const { service, gateway, tradesService, eventEmitter } = makeDeps({
        candles: [candle(2_000, 90, 95, 85)],
        openTrade: openShort,
        fillPrice: 90,
        signal: { ...shortSignal, action: 'EXIT', price: 90, reason: 'EMA20 cruzou acima da EMA50' },
      });

      await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

      expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY', quantity: 2 }));
      // (100 - 90) * 2 = +20, +10%.
      expect(tradesService.closePosition).toHaveBeenCalledWith(
        'trade2',
        expect.objectContaining({ exitPrice: 90, exitReason: 'SIGNAL', pnl: 20, pnlPct: 10 }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'trade.closed',
        expect.objectContaining({ reasonDetail: 'EMA20 cruzou acima da EMA50', pnl: 20 }),
      );
    });

    it('never places an order when risk vetoes the short (e.g. SHORT_NOT_SUPPORTED on Spot)', async () => {
      const { service, gateway, tradesService, signalsService } = makeDeps({
        signal: shortSignal,
        decision: { approved: false, rejectReason: 'SHORT_NOT_SUPPORTED' },
      });

      await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(tradesService.openPosition).not.toHaveBeenCalled();
      expect(signalsService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ENTER_SHORT' }),
        expect.objectContaining({ rejectReason: 'SHORT_NOT_SUPPORTED' }),
        'PAPER',
      );
    });
  });

  it('closes a LONG on a manual/automatic signal exit with a negative pnl when price fell', async () => {
    const openLong = { _id: 'trade3', symbol: 'BTCUSDT', side: 'LONG', mode: 'PAPER', strategy: 'TrendRegimeStrategy', entryPrice: 100, qty: 2, stopLoss: 80, entryTime: new Date(0) };
    const { service, gateway, tradesService } = makeDeps({
      candles: [candle(2_000, 95, 97, 94)],
      openTrade: openLong,
      fillPrice: 95,
      signal: { action: 'EXIT', symbol: 'BTCUSDT', strategy: 'TrendRegimeStrategy', candleTime: 2_000, price: 95, indicators: {}, reason: 'cross' },
    });

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
    expect(tradesService.closePosition).toHaveBeenCalledWith(
      'trade3',
      expect.objectContaining({ exitReason: 'SIGNAL', pnl: -10, pnlPct: -5 }),
    );
  });

  it('closes a LONG on take profit when the high reaches the target', async () => {
    const openLong = { _id: 'trade4', symbol: 'BTCUSDT', side: 'LONG', mode: 'PAPER', strategy: 'TrendRegimeStrategy', entryPrice: 100, qty: 1, stopLoss: 90, takeProfit: 120, entryTime: new Date(0) };
    const { service, tradesService } = makeDeps({
      candles: [candle(2_000, 118, 121, 110)],
      openTrade: openLong,
      signal: { action: 'NONE', symbol: 'BTCUSDT', strategy: 'TrendRegimeStrategy', candleTime: 2_000, price: 118, indicators: {}, reason: 'n/a' },
    });

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(tradesService.closePosition).toHaveBeenCalledWith(
      'trade4',
      expect.objectContaining({ exitPrice: 120, exitReason: 'TP', pnl: 20, pnlPct: 20 }),
    );
  });
});

describe('ExecutionService (LIVE/Binance gateway)', () => {
  it('protects a short with a BUY stop-limit whose limit sits ABOVE the trigger', async () => {
    const deps = makeDeps({
      signal: {
        action: 'ENTER_SHORT',
        symbol: 'BTCUSDT',
        strategy: 'TrendRegimeStrategy',
        candleTime: 1_000,
        price: 100,
        stopLoss: 110,
        indicators: {},
        reason: 'test',
      },
    });
    (deps.gateway as { kind: string }).kind = 'BINANCE';

    await deps.service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(deps.gateway.placeOrder).toHaveBeenNthCalledWith(1, expect.objectContaining({ side: 'SELL', type: 'MARKET' }));
    expect(deps.gateway.placeOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ side: 'BUY', type: 'STOP_LOSS_LIMIT', stopPrice: 110, price: 110 * 1.001 }),
    );
  });
});

describe('ExecutionService - idempotency and restart recovery', () => {
  const HOUR = 3_600_000;
  const hold = (closeTime: number) => ({
    action: 'NONE',
    symbol: 'BTCUSDT',
    strategy: 'TrendRegimeStrategy',
    candleTime: closeTime,
    price: 100,
    indicators: {},
    reason: 'n/a',
  });

  it('a restarted process does not re-evaluate the candle the previous one already handled', async () => {
    const checkpoints = new InMemoryEvaluationCheckpointStore();
    const snapshots = new InMemoryEvaluationSnapshotStore();
    const before = makeDeps({ checkpoints, snapshots });
    await expect(before.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).resolves.toMatchObject({ status: 'evaluated' });

    // "Restart": brand-new service instance (empty memory), same persisted checkpoints and snapshots.
    const after = makeDeps({ checkpoints, snapshots });
    await expect(after.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).resolves.toMatchObject({
      status: 'already-evaluated',
    });
    expect(after.gateway.placeOrder).not.toHaveBeenCalled();
    expect(after.strategy.onCandleClosed).not.toHaveBeenCalled();
  });

  it('after downtime, evaluates the newest closed candle and reports the ones it missed', async () => {
    const checkpoints = new InMemoryEvaluationCheckpointStore();
    const t0 = 10 * HOUR;
    const first = makeDeps({ checkpoints, candles: [candle(t0, 100, 101, 99)], signal: hold(t0) });
    await first.service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    // Worker was down for 3 more candles; on restart Binance returns them all.
    const candles = [0, 1, 2, 3].map((k) => candle(t0 + k * HOUR, 100, 101, 99));
    const restarted = makeDeps({ checkpoints, candles, signal: hold(t0 + 3 * HOUR) });
    const outcome = await restarted.service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(outcome).toEqual({ status: 'evaluated', candleCloseTime: t0 + 3 * HOUR, missedCandles: 2 });
    expect(restarted.strategy.onCandleClosed).toHaveBeenCalledTimes(1);
  });

  it('after downtime, closes a PAPER position whose stop was touched by a missed candle', async () => {
    const checkpoints = new InMemoryEvaluationCheckpointStore();
    const t0 = 10 * HOUR;
    await makeDeps({ checkpoints, candles: [candle(t0, 100, 101, 99)], signal: hold(t0) }).service.runCycle(
      'BTCUSDT',
      'TrendRegimeStrategy',
    );

    const openTrade = {
      _id: 'trade-x',
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice: 100,
      qty: 1,
      stopLoss: 90,
      entryTime: new Date(t0),
    };
    // Missed candle t0+1h dipped to 85 (through the stop); by t0+2h price is back at 100.
    const candles = [
      candle(t0, 100, 101, 99),
      { ...candle(t0 + HOUR, 95, 100, 85), open: 99 },
      candle(t0 + 2 * HOUR, 100, 101, 98),
    ];
    const restarted = makeDeps({ checkpoints, candles, openTrade, signal: hold(t0 + 2 * HOUR) });
    await restarted.service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(restarted.tradesService.closePosition).toHaveBeenCalledWith(
      'trade-x',
      expect.objectContaining({ exitPrice: 90, exitReason: 'SL', exitTime: new Date(t0 + HOUR) }),
    );
  });

  it('a failure before any order frees the candle, so the next tick retries it', async () => {
    const deps = makeDeps();
    deps.tradesService.findOpenPosition.mockRejectedValueOnce(new Error('Mongo timeout'));

    await expect(deps.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).rejects.toThrow('Mongo timeout');
    await expect(deps.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).resolves.toMatchObject({ status: 'evaluated' });
    expect(deps.gateway.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('a failure after an order went out is NOT retried (no duplicate order)', async () => {
    const deps = makeDeps();
    deps.tradesService.openPosition.mockRejectedValueOnce(new Error('Mongo down'));

    await expect(deps.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).rejects.toThrow('Mongo down');
    await expect(deps.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).resolves.toMatchObject({
      status: 'already-evaluated',
    });
    expect(deps.gateway.placeOrder).toHaveBeenCalledTimes(1);
  });

  it('two overlapping processes (deploy) evaluate a candle only once', async () => {
    const checkpoints = new InMemoryEvaluationCheckpointStore();
    const a = makeDeps({ checkpoints });
    const b = makeDeps({ checkpoints });
    // Process "other" holds a live claim on the candle: this one must stay off it.
    await checkpoints.claim('PAPER:BTCUSDT:1h', 1_000, 'other-process');

    await expect(a.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).resolves.toMatchObject({ status: 'already-evaluated' });
    await checkpoints.commit('PAPER:BTCUSDT:1h', 1_000, 'other-process');
    await expect(b.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).resolves.toMatchObject({ status: 'already-evaluated' });
    expect(a.gateway.placeOrder).not.toHaveBeenCalled();
    expect(b.gateway.placeOrder).not.toHaveBeenCalled();
  });

  it('a closed candle is evaluated, then a newer one is evaluated again (LONG and SHORT paths alike)', async () => {
    const t0 = 10 * HOUR;
    const deps = makeDeps({ candles: [candle(t0, 100, 101, 99)], signal: hold(t0) });
    await deps.service.runCycle('BTCUSDT', 'TrendRegimeStrategy');
    deps.gateway.getCandles.mockResolvedValue([candle(t0, 100, 101, 99), candle(t0 + HOUR, 100, 101, 99)]);
    deps.strategy.onCandleClosed.mockReturnValue({ ...hold(t0 + HOUR), action: 'ENTER_SHORT', stopLoss: 110 });

    await expect(deps.service.runCycle('BTCUSDT', 'TrendRegimeStrategy')).resolves.toMatchObject({
      status: 'evaluated',
      candleCloseTime: t0 + HOUR,
    });
    expect(deps.gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL', type: 'MARKET' }));
  });
});

describe('ExecutionService - persisted evaluation snapshots (dashboard after a restart)', () => {
  const HOUR = 3_600_000;
  const T0 = 10 * HOUR;
  const conditions = {
    side: 'LONG' as const,
    cross: { ok: false, emaFast: 99, emaSlow: 100 },
    regime: { ok: true, close: 100, ema: 90, bandPct: 0 },
    rsi: { ok: true, value: 55, min: 45, max: 70 },
  };
  const hold = (closeTime: number) => ({
    action: 'NONE',
    symbol: 'BTCUSDT',
    strategy: 'TrendRegimeStrategy',
    candleTime: closeTime,
    price: 100,
    indicators: { emaFast: 99, emaSlow: 100, emaRegime: 90, rsi: 55 },
    reason: 'sem cruzamento EMA rapida/lenta',
    conditions,
  });
  const run = (deps: ReturnType<typeof makeDeps>) => deps.service.runCycle('BTCUSDT', 'TrendRegimeStrategy');
  const stored = async (deps: ReturnType<typeof makeDeps>) => (await deps.snapshots.get('PAPER', 'BTCUSDT'))!;

  it('first execution ever (no checkpoint, no snapshot): evaluates and stores the snapshot', async () => {
    const deps = makeDeps({ candles: [candle(T0, 100, 101, 99)], signal: hold(T0) });

    await expect(run(deps)).resolves.toMatchObject({ status: 'evaluated' });

    const { snapshot } = await stored(deps);
    expect(snapshot).toMatchObject({
      source: 'cycle',
      action: 'HOLD',
      candleOpenTime: T0 - HOUR,
      candleCloseTime: T0,
      side: 'LONG',
      indicators: { emaFast: 99, emaSlow: 100, emaRegime: 90, rsi: 55 },
      decision: { outcome: 'NOT_ENTERED', reason: 'sem cruzamento EMA rapida/lenta' },
    });
    expect(snapshot!.conditions!.map((c) => [c.key, c.ok])).toEqual([
      ['cross', false],
      ['regime', true],
      ['rsi', true],
    ]);
  });

  it('restart with a stored snapshot: reuses it, without running the strategy or touching risk/orders', async () => {
    const checkpoints = new InMemoryEvaluationCheckpointStore();
    const snapshots = new InMemoryEvaluationSnapshotStore();
    const before = makeDeps({ checkpoints, snapshots, candles: [candle(T0, 100, 101, 99)], signal: hold(T0) });
    await run(before);
    const original = (await stored(before)).snapshot;

    const after = makeDeps({ checkpoints, snapshots, candles: [candle(T0, 100, 101, 99)], signal: hold(T0) });
    await expect(run(after)).resolves.toMatchObject({ status: 'already-evaluated' });

    expect(after.strategy.onCandleClosed).not.toHaveBeenCalled();
    expect(after.riskManager.evaluate).not.toHaveBeenCalled();
    expect(after.gateway.placeOrder).not.toHaveBeenCalled();
    expect((await stored(after)).snapshot).toEqual(original);
  });

  it('restart without a stored snapshot: re-runs only the strategy, informationally, and stores it', async () => {
    const checkpoints = new InMemoryEvaluationCheckpointStore();
    // A previous run (before snapshots existed) evaluated the candle: checkpoint committed, nothing stored.
    await checkpoints.claim('PAPER:BTCUSDT:1h', T0, 'old');
    await checkpoints.commit('PAPER:BTCUSDT:1h', T0, 'old');
    // Even an entry signal must not trade here: the candle was already handled.
    const entry = {
      ...hold(T0),
      action: 'ENTER_LONG',
      stopLoss: 90,
      conditions: { ...conditions, cross: { ...conditions.cross, ok: true } },
    };
    const deps = makeDeps({ checkpoints, candles: [candle(T0, 100, 101, 99)], signal: entry });

    await expect(run(deps)).resolves.toMatchObject({ status: 'already-evaluated' });

    expect(deps.strategy.onCandleClosed).toHaveBeenCalledTimes(1);
    expect(deps.riskManager.evaluate).not.toHaveBeenCalled();
    expect(deps.riskContextBuilder.build).not.toHaveBeenCalled();
    expect(deps.signalsService.record).not.toHaveBeenCalled();
    expect(deps.gateway.placeOrder).not.toHaveBeenCalled();
    expect(deps.tradesService.openPosition).not.toHaveBeenCalled();
    expect(deps.ordersService.create).not.toHaveBeenCalled();
    expect((await stored(deps)).snapshot).toMatchObject({
      source: 'reconciliation',
      action: 'ENTER_LONG',
      candleCloseTime: T0,
      decision: { outcome: 'INFORMATIONAL' },
    });
  });

  it('two restarts on the same candle: one trade in total, and the cycle snapshot is never overwritten', async () => {
    const checkpoints = new InMemoryEvaluationCheckpointStore();
    const snapshots = new InMemoryEvaluationSnapshotStore();
    // Default signal: ENTER_LONG approved by risk.
    const newProcess = () => makeDeps({ checkpoints, snapshots, candles: [candle(T0, 100, 101, 99)] });
    const first = newProcess();
    await run(first);
    const original = (await stored(first)).snapshot;
    expect(original).toMatchObject({ source: 'cycle', decision: { outcome: 'ENTERED' } });

    const second = newProcess();
    const third = newProcess();
    await run(second);
    await run(third);
    await run(third); // and the next tick of the same process

    const all = [first, second, third];
    expect(all.reduce((n, d) => n + d.gateway.placeOrder.mock.calls.length, 0)).toBe(1);
    expect(all.reduce((n, d) => n + d.tradesService.openPosition.mock.calls.length, 0)).toBe(1);
    expect((await stored(third)).snapshot).toEqual(original);
  });

  it('a reconciliation snapshot never replaces a cycle one of the same candle', async () => {
    const snapshots = new InMemoryEvaluationSnapshotStore();
    const deps = makeDeps({ snapshots, candles: [candle(T0, 100, 101, 99)], signal: hold(T0) });
    await run(deps);
    const original = (await stored(deps)).snapshot!;

    await expect(snapshots.save({ ...original, source: 'reconciliation', action: 'ENTER_LONG' })).resolves.toBe(false);
    expect((await stored(deps)).snapshot).toEqual(original);
  });

  it('exchange failure: the cycle fails as MarketDataError, the error is stored, and the next fetch clears it', async () => {
    const deps = makeDeps({ candles: [candle(T0, 100, 101, 99)], signal: hold(T0) });
    deps.gateway.getCandles.mockRejectedValueOnce(new Error('ETIMEDOUT api.binance.com'));

    await expect(run(deps)).rejects.toThrow(MarketDataError);
    await expect(stored(deps)).resolves.toMatchObject({
      snapshot: null,
      lastError: expect.stringContaining('ETIMEDOUT api.binance.com'),
      lastErrorAt: expect.any(Date),
    });
    expect(deps.gateway.placeOrder).not.toHaveBeenCalled();

    await expect(run(deps)).resolves.toMatchObject({ status: 'evaluated' });
    await expect(stored(deps)).resolves.toMatchObject({
      lastError: null,
      snapshot: expect.objectContaining({ candleCloseTime: T0 }),
    });
  });

  it('an exchange failure after a restart keeps the last snapshot visible next to the error', async () => {
    const deps = makeDeps({ candles: [candle(T0, 100, 101, 99)], signal: hold(T0) });
    await run(deps);

    const restarted = makeDeps({ checkpoints: deps.checkpoints, snapshots: deps.snapshots });
    restarted.gateway.getCandles.mockRejectedValueOnce(new Error('HTTP 451'));
    await expect(run(restarted)).rejects.toThrow(MarketDataError);

    await expect(stored(deps)).resolves.toMatchObject({
      snapshot: expect.objectContaining({ candleCloseTime: T0, source: 'cycle' }),
      lastError: expect.stringContaining('HTTP 451'),
    });
  });

  it('after downtime of several candles, reports the gap and evaluates only the latest candle', async () => {
    const checkpoints = new InMemoryEvaluationCheckpointStore();
    const first = makeDeps({ checkpoints, candles: [candle(T0, 100, 101, 99)], signal: hold(T0) });
    await run(first);

    const candles = [0, 1, 2, 3].map((k) => candle(T0 + k * HOUR, 100, 101, 99));
    const restarted = makeDeps({ checkpoints, candles, signal: hold(T0 + 3 * HOUR) });
    await expect(run(restarted)).resolves.toMatchObject({ status: 'evaluated', missedCandles: 2 });

    expect(restarted.strategy.onCandleClosed).toHaveBeenCalledTimes(1);
    expect(restarted.eventEmitter.emit).toHaveBeenCalledWith('worker.gap', {
      symbol: 'BTCUSDT',
      mode: 'PAPER',
      timeframe: '1h',
      missedCandles: 2,
      lastEvaluatedCandleClose: new Date(T0).toISOString(),
      firstMissedCandleClose: new Date(T0 + HOUR).toISOString(),
      lastMissedCandleClose: new Date(T0 + 2 * HOUR).toISOString(),
      evaluatedCandleClose: new Date(T0 + 3 * HOUR).toISOString(),
    });
  });

  it('a failing snapshot store never breaks the trading cycle', async () => {
    const snapshots = new InMemoryEvaluationSnapshotStore();
    jest.spyOn(snapshots, 'save').mockRejectedValue(new Error('Mongo down'));
    jest.spyOn(snapshots, 'clearError').mockRejectedValue(new Error('Mongo down'));
    const deps = makeDeps({ snapshots });

    await expect(run(deps)).resolves.toMatchObject({ status: 'evaluated' });
    expect(deps.gateway.placeOrder).toHaveBeenCalledTimes(1);
  });
});
