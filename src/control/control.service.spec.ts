import { ControlService } from './control.service';

function makeDeps(overrides: { openOrders?: unknown[]; openTrades?: unknown[] } = {}) {
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
    closePosition: jest.fn().mockResolvedValue(undefined),
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
    { mode: 'PAPER' } as never,
    eventEmitter as never,
    { enabled: true, pollIntervalSeconds: 60 } as never,
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
    expect(eventEmitter.emit).toHaveBeenCalledWith('bot.paused', { reason: 'MANUAL' });

    await service.resume();
    expect(await service.isPaused()).toBe(false);
    expect((await service.getState()).pauseReason).toBeUndefined();
    expect(eventEmitter.emit).toHaveBeenCalledWith('bot.resumed', {});
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
});
