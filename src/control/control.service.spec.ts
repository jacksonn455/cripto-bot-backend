import { TradesService } from '../trades/trades.service';
import { ControlService } from './control.service';
import { InMemoryEvaluationSnapshotStore } from './evaluation-snapshot.store';

/** Minimal pause_episodes model: the calls ControlService makes, over an array. */
function fakeEpisodeModel(failing = false) {
  const docs: Array<Record<string, unknown>> = [];
  const newestOpen = () =>
    [...docs].filter((d) => d.resumedAt === undefined).sort((a, b) => +(b.pausedAt as Date) - +(a.pausedAt as Date))[0] ?? null;
  const fail = () => Promise.reject(new Error('mongo down'));
  return {
    docs,
    create: jest.fn((doc: Record<string, unknown>) => {
      if (failing) return fail();
      const d = { _id: `e${docs.length + 1}`, ...doc };
      docs.push(d);
      return Promise.resolve(d);
    }),
    findOne: jest.fn(() => ({ sort: () => (failing ? fail() : Promise.resolve(newestOpen())) })),
    updateOne: jest.fn((filter: { _id: string }, update: { $set?: Record<string, unknown>; $push?: Record<string, unknown> }) => {
      const d = docs.find((x) => x._id === filter._id)!;
      Object.assign(d, update.$set ?? {});
      for (const [k, v] of Object.entries(update.$push ?? {})) d[k] = [...((d[k] as unknown[]) ?? []), v];
      return Promise.resolve({});
    }),
    find: jest.fn(() => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([...docs].reverse()) }) }) })),
  };
}

function makeDeps(overrides: { openOrders?: unknown[]; openTrades?: unknown[]; episodes?: ReturnType<typeof fakeEpisodeModel> } = {}) {
  const state: Record<string, unknown> = { isPaused: false };
  const stateModel = {
    findOne: jest.fn().mockImplementation(() => Promise.resolve({ ...state })),
    create: jest.fn().mockImplementation((doc: Record<string, unknown>) => {
      Object.assign(state, doc);
      return Promise.resolve({ ...state });
    }),
    updateOne: jest.fn().mockImplementation(
      (_filter: unknown, update: { $set: Record<string, unknown>; $unset?: Record<string, unknown> }) => {
      Object.assign(state, update.$set);
      for (const key of Object.keys(update.$unset ?? {})) delete state[key];
      return Promise.resolve({});
    }),
  };

  const gateway = {
    getOpenOrders: jest.fn().mockResolvedValue(overrides.openOrders ?? []),
    getBalance: jest.fn().mockResolvedValue({ asset: 'USDT', free: 1000, locked: 0 }),
    cancelOrder: jest.fn().mockResolvedValue(undefined),
    placeOrder: jest.fn().mockResolvedValue({
      symbol: 'BTCUSDT',
      orderId: '1',
      clientOrderId: 'x',
      side: 'SELL',
      type: 'MARKET',
      status: 'FILLED',
      price: 95,
      origQty: 1,
      executedQty: 1,
      createdAt: Date.now(),
    }),
  };

  const tradesService = {
    findAllOpen: jest.fn().mockResolvedValue(overrides.openTrades ?? []),
    countOpenPositions: jest.fn().mockResolvedValue(0),
    closePosition: jest.fn().mockResolvedValue(undefined),
    // Real settlement math on top of the mocked persistence.
    settlePosition(...args: Parameters<TradesService['settlePosition']>) {
      return TradesService.prototype.settlePosition.apply(this as never, args);
    },
  };

  const eventEmitter = { emit: jest.fn() };
  const runtimeStatus = {
    getLastCycleAt: jest.fn().mockReturnValue(null),
    getLastSignalBySymbol: jest.fn().mockReturnValue({}),
    getLastError: jest.fn().mockReturnValue(null),
    getLastPollAt: jest.fn().mockReturnValue(null),
  };

  const service = new ControlService(
    stateModel as never,
    gateway as never,
    tradesService as never,
    runtimeStatus as never,
    { getStatus: jest.fn().mockResolvedValue({ state: 'ONLINE' }) } as never,
    { mode: 'PAPER' } as never,
    eventEmitter as never,
    { enabled: true, pollIntervalSeconds: 60 } as never,
    undefined,
    overrides.episodes as never,
  );

  return { service, stateModel, gateway, tradesService, eventEmitter, state };
}

describe('ControlService', () => {
  it('starts unpaused by default', async () => {
    const { service } = makeDeps();
    expect(await service.isPaused()).toBe(false);
  });

  it('pauses and resumes, emitting domain events', async () => {
    const { service, eventEmitter } = makeDeps();

    await service.pause('MANUAL');
    expect(await service.isPaused()).toBe(true);
    expect(eventEmitter.emit).toHaveBeenCalledWith('bot.paused', { reason: 'MANUAL', pausedAt: expect.any(String) });

    await service.resume();
    expect(await service.isPaused()).toBe(false);
    expect((await service.getState()).pauseReason).toBeUndefined();
    expect(eventEmitter.emit).toHaveBeenCalledWith('bot.resumed', {
      pauseReason: 'MANUAL',
      pausedAt: expect.any(String),
      pausedForMs: expect.any(Number),
    });
  });

  describe('pause episodes (observability)', () => {
    beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-01T10:00:00Z') }));
    afterEach(() => jest.useRealTimers());

    it('records when and why the bot paused, how long it stayed paused, and exposes it on the status', async () => {
      const episodes = fakeEpisodeModel();
      const { service, state } = makeDeps({ episodes });

      await service.pause('CONSECUTIVE_STOPS_LIMIT');
      expect(state.pausedAt).toEqual(new Date('2026-10-01T10:00:00Z'));
      jest.setSystemTime(new Date('2026-10-01T13:30:00Z'));
      const status = await service.getStatus();
      expect(status).toMatchObject({ paused: true, pauseReason: 'CONSECUTIVE_STOPS_LIMIT', pausedForMs: 3.5 * 3_600_000 });

      await service.resume();
      expect(episodes.docs).toEqual([
        expect.objectContaining({
          reason: 'CONSECUTIVE_STOPS_LIMIT',
          mode: 'PAPER',
          pausedAt: new Date('2026-10-01T10:00:00Z'),
          resumedAt: new Date('2026-10-01T13:30:00Z'),
          durationMs: 3.5 * 3_600_000,
        }),
      ]);
      expect(state.pausedAt).toBeUndefined();
      expect((await service.getStatus()).pausedForMs).toBeUndefined();
    });

    it('a pause while already paused keeps the original start and is appended to the same episode', async () => {
      const episodes = fakeEpisodeModel();
      const { service, state } = makeDeps({ episodes });

      await service.pause('CONSECUTIVE_STOPS_LIMIT');
      jest.setSystemTime(new Date('2026-10-01T11:00:00Z'));
      await service.pause('DAILY_LOSS_LIMIT');

      expect(state.pausedAt).toEqual(new Date('2026-10-01T10:00:00Z'));
      expect(state.pauseReason).toBe('DAILY_LOSS_LIMIT');
      expect(episodes.docs).toHaveLength(1);
      expect(episodes.docs[0].additionalReasons).toEqual([{ reason: 'DAILY_LOSS_LIMIT', at: new Date('2026-10-01T11:00:00Z') }]);
    });

    it('still pauses (the safety mechanism) when the episode cannot be written', async () => {
      const { service } = makeDeps({ episodes: fakeEpisodeModel(true) });
      await service.pause('DAILY_LOSS_LIMIT');
      expect(await service.isPaused()).toBe(true);
      await service.resume();
      expect(await service.isPaused()).toBe(false);
    });
  });

  it('auto-pauses when the daily loss limit is breached', async () => {
    const { service } = makeDeps();

    await service.checkAutoPauseConditions({
      dailyPnl: -300,
      accountEquity: 10000,
      maxDailyLossPct: 0.03,
      consecutiveStopLosses: 0,
      maxConsecutiveStops: 3,
    });

    expect(await service.isPaused()).toBe(true);
  });

  it('auto-pauses after too many consecutive stop losses', async () => {
    const { service } = makeDeps();

    await service.checkAutoPauseConditions({
      dailyPnl: 0,
      accountEquity: 10000,
      maxDailyLossPct: 0.03,
      consecutiveStopLosses: 3,
      maxConsecutiveStops: 3,
    });

    expect(await service.isPaused()).toBe(true);
  });

  it('does not auto-pause when thresholds are not breached', async () => {
    const { service } = makeDeps();

    await service.checkAutoPauseConditions({
      dailyPnl: -10,
      accountEquity: 10000,
      maxDailyLossPct: 0.03,
      consecutiveStopLosses: 1,
      maxConsecutiveStops: 3,
    });

    expect(await service.isPaused()).toBe(false);
  });

  it('kill switch cancels open orders, closes open positions, and pauses the bot', async () => {
    const openOrders = [{ symbol: 'BTCUSDT', clientOrderId: 'o1' }];
    const openTrades = [{ _id: 't1', symbol: 'BTCUSDT', qty: 1, entryPrice: 100 }];
    const { service, gateway, tradesService, eventEmitter } = makeDeps({ openOrders, openTrades });

    const result = await service.killSwitch();

    expect(gateway.cancelOrder).toHaveBeenCalledWith('BTCUSDT', 'o1');
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET' }),
    );
    expect(tradesService.closePosition).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ exitReason: 'KILL_SWITCH' }),
    );
    expect(result).toEqual({ canceledOrders: 1, closedPositions: 1 });
    expect(await service.isPaused()).toBe(true);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'alert.critical',
      expect.objectContaining({ message: expect.stringContaining('Kill switch triggered') }),
    );
  });

  it('kill switch flattens a SHORT with a BUY and books a direction-aware pnl + trade.closed', async () => {
    const openTrades = [{ _id: 't2', symbol: 'BTCUSDT', side: 'SHORT', mode: 'PAPER', qty: 2, entryPrice: 100, entryTime: new Date(0) }];
    const { service, gateway, tradesService, eventEmitter } = makeDeps({ openTrades });

    await service.killSwitch();

    expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY', quantity: 2 }));
    // Bought back at 95 after shorting at 100: +10.
    expect(tradesService.closePosition).toHaveBeenCalledWith(
      't2',
      expect.objectContaining({ exitReason: 'KILL_SWITCH', exitPrice: 95, pnl: 10, pnlPct: 5 }),
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith('trade.closed', expect.objectContaining({ side: 'SHORT', reason: 'KILL_SWITCH' }));
  });
});

describe('ControlService.getStatus - persisted evaluations', () => {
  const HOUR = 3_600_000;
  const base = {
    mode: 'PAPER',
    timeframe: '1h',
    regimeTimeframe: '4h',
    source: 'cycle' as const,
    action: 'HOLD',
    reason: 'sem cruzamento EMA rapida/lenta',
    price: 64_000,
    indicators: { emaFast: 63_900, emaSlow: 64_100, emaRegime: 61_000, rsi: 55 },
    decision: { outcome: 'NOT_ENTERED' as const, reason: 'sem cruzamento EMA rapida/lenta' },
  };

  function makeStatusService(snapshots: InMemoryEvaluationSnapshotStore, heartbeatLastEvaluationAt: Date | null) {
    return new ControlService(
      { findOne: jest.fn().mockResolvedValue({ isPaused: false, lastReconciliationOk: true }) } as never,
      { getBalance: jest.fn().mockResolvedValue({ free: 1000 }) } as never,
      { countOpenPositions: jest.fn().mockResolvedValue(0) } as never,
      {
        getLastCycleAt: jest.fn().mockReturnValue(null),
        getLastError: jest.fn().mockReturnValue(null),
        getLastPollAt: jest.fn().mockReturnValue(null),
      } as never,
      { getStatus: jest.fn().mockResolvedValue({ state: 'ONLINE', lastEvaluationAt: heartbeatLastEvaluationAt }) } as never,
      { mode: 'PAPER' } as never,
      { emit: jest.fn() } as never,
      { enabled: true, pollIntervalSeconds: 60 } as never,
      snapshots,
    );
  }

  it('the worker card and the per-symbol panel show the same evaluation time, from the same snapshots', async () => {
    const snapshots = new InMemoryEvaluationSnapshotStore();
    const btcAt = new Date('2026-10-01T16:00:31Z');
    const ethAt = new Date('2026-10-01T16:00:33Z');
    await snapshots.save({ ...base, symbol: 'BTCUSDT', candleOpenTime: 15 * HOUR, candleCloseTime: 16 * HOUR - 1, evaluatedAt: btcAt });
    await snapshots.save({ ...base, symbol: 'ETHUSDT', candleOpenTime: 15 * HOUR, candleCloseTime: 16 * HOUR - 1, evaluatedAt: ethAt });
    // The heartbeat document says something else (e.g. a tick time carried from the previous run).
    const status = await makeStatusService(snapshots, new Date('2026-10-01T15:00:30Z')).getStatus();

    expect(status.worker.lastEvaluationAt).toEqual(ethAt);
    expect(status.lastSignalBySymbol.ETHUSDT.at).toEqual(ethAt);
    expect(status.lastSignalBySymbol.BTCUSDT).toMatchObject({
      at: btcAt,
      action: 'HOLD',
      candleTime: new Date(16 * HOUR - 1).toISOString(),
      candleOpenTime: new Date(15 * HOUR).toISOString(),
      source: 'cycle',
      indicators: base.indicators,
    });
    expect(status.lastCycleAt).toEqual(ethAt);
  });

  it('reports market-data errors per symbol, and falls back to the heartbeat when nothing is stored', async () => {
    const snapshots = new InMemoryEvaluationSnapshotStore();
    const errorAt = new Date('2026-10-01T16:01:00Z');
    await snapshots.recordError('PAPER', 'BTCUSDT', 'HTTP 451', errorAt);
    const heartbeatAt = new Date('2026-10-01T15:00:30Z');

    const status = await makeStatusService(snapshots, heartbeatAt).getStatus();

    expect(status.lastSignalBySymbol).toEqual({});
    expect(status.symbolErrors).toEqual({ BTCUSDT: { message: 'HTTP 451', at: errorAt } });
    expect(status.worker.lastEvaluationAt).toEqual(heartbeatAt);
  });

  it('still answers when the snapshot store is unreachable', async () => {
    const snapshots = new InMemoryEvaluationSnapshotStore();
    jest.spyOn(snapshots, 'list').mockRejectedValue(new Error('Mongo down'));

    const status = await makeStatusService(snapshots, null).getStatus();

    expect(status.lastSignalBySymbol).toEqual({});
    expect(status.worker.state).toBe('ONLINE');
  });
});
