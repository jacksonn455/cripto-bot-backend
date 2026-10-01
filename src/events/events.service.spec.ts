import { firstValueFrom, filter, take, toArray } from 'rxjs';
import { RuntimeStatusService } from '../control/runtime-status.service';
import { EventsService } from './events.service';

function makeService() {
  const eventModel = {
    create: jest.fn().mockResolvedValue({}),
    exists: jest.fn().mockResolvedValue(null),
    find: jest.fn(() => ({
      sort: () => ({
        limit: () => ({
          lean: () =>
            Promise.resolve([{ _id: '66f8a1b2c3d4e5f6a7b8c9d0', type: 'bot.paused', data: { reason: 'MANUAL' }, at: new Date('2026-09-29T12:00:00.000Z') }]),
        }),
      }),
    })),
  };
  const service = new EventsService(eventModel as never, { mode: 'PAPER' } as never);
  return { service, eventModel };
}

describe('EventsService', () => {
  it('forwards domain events as named SSE messages with an id and stores them', async () => {
    const { service, eventModel } = makeService();
    const received = firstValueFrom(service.asObservable().pipe(filter((m) => m.type !== 'ping'), take(2), toArray()));

    service.onSignal({ symbol: 'BTCUSDT', approved: false, rejectReason: 'RR_TOO_LOW', mode: 'PAPER' });
    service.onError({ message: 'boom' });

    const [signal, error] = await received;
    expect(signal.type).toBe('signal.recorded');
    expect(JSON.parse(signal.data as string)).toEqual({ symbol: 'BTCUSDT', approved: false, rejectReason: 'RR_TOO_LOW', mode: 'PAPER' });
    expect(signal.id).toMatch(/^[0-9a-f]{24}$/);
    // Bot-level events get the trading mode added.
    expect(JSON.parse(error.data as string)).toEqual({ message: 'boom', mode: 'PAPER' });

    expect(eventModel.create).toHaveBeenCalledTimes(2);
    expect(eventModel.create.mock.calls[0][0]).toMatchObject({ type: 'signal.recorded' });
    expect(String(eventModel.create.mock.calls[0][0]._id)).toBe(signal.id);
  });

  it('flags a cycle for a candle already in the history as a re-evaluation (restart)', async () => {
    const { service, eventModel } = makeService();
    const received = firstValueFrom(service.asObservable().pipe(filter((m) => m.type === 'bot.cycle'), take(2), toArray()));
    const cycle = { symbol: 'BTCUSDT', action: 'HOLD', reason: 'x', at: '2026-09-29T13:00:05.000Z', candleTime: '2026-09-29T12:59:59.999Z' };

    await service.onCycle(cycle);
    eventModel.exists.mockResolvedValueOnce({ _id: 'earlier' });
    await service.onCycle(cycle);

    const [first, repeat] = (await received).map((m) => JSON.parse(m.data as string));
    expect(first.reevaluation).toBe(false);
    expect(repeat.reevaluation).toBe(true);
    expect(eventModel.exists).toHaveBeenCalledWith({ type: 'bot.cycle', 'data.symbol': 'BTCUSDT', 'data.candleTime': '2026-09-29T12:59:59.999Z' });
  });

  it('keeps streaming when storing the history fails', async () => {
    const { service, eventModel } = makeService();
    eventModel.create.mockRejectedValueOnce(new Error('mongo down'));
    const received = firstValueFrom(service.asObservable().pipe(filter((m) => m.type !== 'ping'), take(1)));
    service.onBotResumed({});
    await expect(received).resolves.toMatchObject({ type: 'bot.resumed' });
  });

  it('returns the history newest first with string ids and ISO dates', async () => {
    const { service } = makeService();
    await expect(service.recent(10)).resolves.toEqual([
      { id: '66f8a1b2c3d4e5f6a7b8c9d0', type: 'bot.paused', data: { reason: 'MANUAL' }, at: '2026-09-29T12:00:00.000Z' },
    ]);
  });
});

describe('RuntimeStatusService', () => {
  it('emits bot.error only when the message changes', () => {
    const emitter = { emit: jest.fn() };
    const status = new RuntimeStatusService(emitter as never);

    status.recordError('timeout');
    status.recordError('timeout');
    status.recordError('other');

    const errors = emitter.emit.mock.calls.filter(([t]) => t === 'bot.error');
    expect(errors).toHaveLength(2);
    expect(errors[0][1]).toMatchObject({ message: 'timeout' });
    expect(status.getLastError()).toBe('other');
  });

  it('emits bot.cycle for every evaluated candle (HOLD/EXIT reach the event history)', () => {
    const emitter = { emit: jest.fn() };
    new RuntimeStatusService(emitter as never).recordCycle('BTCUSDT', 'HOLD', 'sem cruzamento');
    expect(emitter.emit).toHaveBeenCalledWith('bot.cycle', expect.objectContaining({ symbol: 'BTCUSDT', action: 'HOLD', reason: 'sem cruzamento' }));
  });

  // The per-symbol snapshot now lives in evaluation_snapshots (see ControlService.getStatus).
  it('carries the evaluated candle and indicators in the event', () => {
    const emitter = { emit: jest.fn() };
    const status = new RuntimeStatusService(emitter as never);
    const indicators = { emaFast: 100, emaSlow: 101, rsi: 55, atr: 2, emaRegime: 90 };
    status.recordCycle('ETHUSDT', 'HOLD', 'sem cruzamento', { candleTime: Date.parse('2026-09-29T12:59:59.999Z'), price: 99, indicators });

    const expected = { candleTime: '2026-09-29T12:59:59.999Z', price: 99, indicators };
    expect(emitter.emit).toHaveBeenCalledWith('bot.cycle', expect.objectContaining(expected));
    expect(status.getLastCycleAt()).not.toBeNull();
  });
});
