import { WORKER_INSTANCE_ID, WorkerHeartbeatService } from './worker-heartbeat.service';

type Doc = Record<string, unknown>;

/** Just enough of a Mongoose model for one singleton document: findById().lean() + updateOne. */
function fakeModel(initial?: Doc) {
  const db: { doc?: Doc } = { doc: initial ? { ...initial } : undefined };
  const matches = (filter: Doc) =>
    db.doc !== undefined && Object.entries(filter).every(([k, v]) => k === '_id' || db.doc![k] === v);
  return {
    db,
    findById: jest.fn(() => ({ lean: () => Promise.resolve(db.doc ? { ...db.doc } : null) })),
    updateOne: jest.fn((filter: Doc, update: Record<string, Doc>, opts?: { upsert?: boolean }) => {
      if (!matches(filter)) {
        if (!opts?.upsert || db.doc) return Promise.resolve({ matchedCount: 0 });
        db.doc = { _id: filter._id, ...update.$setOnInsert };
      }
      Object.assign(db.doc!, update.$set ?? {});
      for (const k of Object.keys(update.$unset ?? {})) delete db.doc![k];
      return Promise.resolve({ matchedCount: 1 });
    }),
  };
}

const CONFIG = {
  enabled: true,
  pollIntervalSeconds: 60,
  workerHeartbeatTimeoutSeconds: 300,
  workerDowntimeAlertMinutes: 10,
};
const STRATEGY = { symbols: ['BTCUSDT', 'ETHUSDT'], timeframe: '1h' };
const at = (iso: string) => new Date(iso);

function make(initial?: Doc, config: Partial<typeof CONFIG> = {}) {
  const model = fakeModel(initial);
  const eventEmitter = { emit: jest.fn() };
  const service = new WorkerHeartbeatService(
    model as never,
    eventEmitter as never,
    { ...CONFIG, ...config } as never,
    STRATEGY as never,
  );
  return { service, model, eventEmitter };
}

describe('WorkerHeartbeatService', () => {
  it('on start after an overnight gap, records and announces the downtime', async () => {
    const { service, model, eventEmitter } = make({
      _id: 'krypto-worker',
      instanceId: 'old',
      status: 'running',
      startedAt: at('2026-09-30T12:00:00Z'),
      lastHeartbeatAt: at('2026-10-01T01:45:00Z'), // 22:45 BRT
      lastEvaluationAt: at('2026-10-01T01:00:00Z'),
    });

    service.markLoopStarted(at('2026-10-01T12:02:00Z')); // 09:02 BRT
    await service.registerStart(at('2026-10-01T12:02:00Z'));
    expect(model.db.doc).toMatchObject({ instanceId: WORKER_INSTANCE_ID, status: 'running' });
    // Announced after the first tick, which knows how many candles were missed.
    expect(eventEmitter.emit).not.toHaveBeenCalledWith('worker.started', expect.anything());
    await service.beat({ evaluated: true, errors: [], missedCandles: 20 }, at('2026-10-01T12:02:01Z'));

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'worker.started',
      expect.objectContaining({
        missedCandles: 20,
        previous: expect.objectContaining({ status: 'running', stopReason: null }),
        downtime: {
          from: '2026-10-01T01:45:00.000Z',
          to: '2026-10-01T12:02:00.000Z',
          durationSeconds: 37_020,
          lastEvaluationAt: '2026-10-01T01:00:00.000Z',
          previousStopReason: null, // no clean stop recorded: the process just vanished
        },
      }),
    );
  });

  it('a quick restart (deploy) is not a downtime', async () => {
    const { service, eventEmitter } = make({
      _id: 'krypto-worker',
      instanceId: 'old',
      status: 'stopped',
      stopReason: 'SIGTERM',
      stoppedAt: at('2026-10-01T12:00:30Z'),
      startedAt: at('2026-09-30T12:00:00Z'),
      lastHeartbeatAt: at('2026-10-01T12:00:00Z'),
    });

    service.markLoopStarted(at('2026-10-01T12:01:30Z'));
    await service.registerStart(at('2026-10-01T12:01:30Z'));
    await service.beat({ evaluated: false, errors: [] }, at('2026-10-01T12:01:31Z'));

    const payload = eventEmitter.emit.mock.calls.find(([e]) => e === 'worker.started')![1];
    expect(payload.downtime).toBeUndefined();
    expect(payload.previous).toMatchObject({ status: 'stopped', stopReason: 'SIGTERM' });
  });

  it('markCrashed records the crash for the next run (and OFFLINE "worker crashed" meanwhile)', async () => {
    const { service, model } = make({ _id: 'krypto-worker', instanceId: WORKER_INSTANCE_ID, status: 'running', startedAt: at('2026-10-01T00:00:00Z'), lastHeartbeatAt: at('2026-10-01T12:00:00Z') });

    await service.markCrashed('TypeError: x is undefined', 2_000, at('2026-10-01T12:00:05Z'));

    expect(model.db.doc).toMatchObject({ status: 'crashed', stopReason: 'uncaughtException', crashError: 'TypeError: x is undefined' });
    await expect(service.getStatus(at('2026-10-01T12:00:10Z'))).resolves.toMatchObject({ state: 'OFFLINE', reason: 'worker crashed' });
  });

  describe('getStatus (what the dashboard shows)', () => {
    const now = at('2026-10-01T12:30:20Z');

    it('ONLINE with uptime, last heartbeat and next evaluation', async () => {
      const { service } = make({
        _id: 'krypto-worker',
        instanceId: 'i1',
        status: 'running',
        startedAt: at('2026-10-01T00:00:00Z'),
        lastHeartbeatAt: at('2026-10-01T12:30:12Z'),
        lastEvaluationAt: at('2026-10-01T12:00:40Z'),
      });

      const s = await service.getStatus(now);

      expect(s.state).toBe('ONLINE');
      expect(s.reason).toBeNull();
      expect(s.uptimeSeconds).toBe(12 * 3600 + 30 * 60 + 20);
      expect(s.nextEvaluationAt).toEqual(at('2026-10-01T13:00:00Z'));
    });

    it('OFFLINE "worker heartbeat expired" when the heartbeat is old — regardless of trades', async () => {
      const { service } = make({
        _id: 'krypto-worker',
        instanceId: 'i1',
        status: 'running',
        startedAt: at('2026-10-01T00:00:00Z'),
        lastHeartbeatAt: at('2026-10-01T10:16:00Z'),
        lastEvaluationAt: at('2026-10-01T10:00:30Z'),
      });

      const s = await service.getStatus(now);

      expect(s).toMatchObject({ state: 'OFFLINE', reason: 'worker heartbeat expired', uptimeSeconds: null });
      expect(s.lastHeartbeatAt).toEqual(at('2026-10-01T10:16:00Z'));
      expect(s.lastEvaluationAt).toEqual(at('2026-10-01T10:00:30Z'));
    });

    it('OFFLINE with the stop reason after a clean shutdown', async () => {
      const { service } = make({
        _id: 'krypto-worker',
        instanceId: 'i1',
        status: 'stopped',
        stopReason: 'SIGTERM',
        stoppedAt: at('2026-10-01T12:30:00Z'),
        startedAt: at('2026-10-01T00:00:00Z'),
        lastHeartbeatAt: at('2026-10-01T12:30:00Z'),
      });

      await expect(service.getStatus(now)).resolves.toMatchObject({ state: 'OFFLINE', reason: 'worker stopped (SIGTERM)' });
    });

    it('STARTING before the first heartbeat, DISABLED when execution is off', async () => {
      await expect(make().service.getStatus(now)).resolves.toMatchObject({ state: 'STARTING' });
      await expect(make(undefined, { enabled: false }).service.getStatus(now)).resolves.toMatchObject({ state: 'DISABLED' });
    });
  });

  it('beat() persists heartbeat, evaluation and errors; the first beat also registers the start', async () => {
    const { service, model } = make();
    service.markLoopStarted(at('2026-10-01T12:00:00Z'));

    await service.beat({ evaluated: true, errors: ['Execution cycle failed for BTCUSDT: x'] }, at('2026-10-01T12:01:00Z'));

    expect(model.db.doc).toMatchObject({
      status: 'running',
      lastHeartbeatAt: at('2026-10-01T12:01:00Z'),
      lastEvaluationAt: at('2026-10-01T12:01:00Z'),
      lastError: 'Execution cycle failed for BTCUSDT: x',
      startedAt: at('2026-10-01T12:00:00Z'),
    });
  });

  it('beat() never throws when Mongo is unreachable (the loop keeps running)', async () => {
    const { service, model } = make();
    model.findById.mockImplementation(() => ({ lean: () => Promise.reject(new Error('ECONNREFUSED')) }));
    model.updateOne.mockRejectedValue(new Error('ECONNREFUSED'));
    service.markLoopStarted();

    await expect(service.beat({ evaluated: false, errors: [] })).resolves.toBeUndefined();
    expect(service.loopState()).toBe('running');
  });

  it('markStopped only touches the document this process owns', async () => {
    const { service, model } = make({ _id: 'krypto-worker', instanceId: 'new-deploy', status: 'running' });

    await service.markStopped('SIGTERM');

    expect(model.db.doc).toMatchObject({ instanceId: 'new-deploy', status: 'running' });
  });

  it('watchdog: a loop that stops ticking is flagged once, and its recovery is announced', async () => {
    const { service, eventEmitter } = make();
    service.markLoopStarted(at('2026-10-01T12:00:00Z'));
    await service.beat({ evaluated: false, errors: [] }, at('2026-10-01T12:00:00Z'));

    expect(service.loopState(at('2026-10-01T12:04:00Z').getTime())).toBe('running');
    service.checkStall(at('2026-10-01T12:06:00Z'));
    service.checkStall(at('2026-10-01T12:07:00Z'));
    expect(service.loopState(at('2026-10-01T12:06:00Z').getTime())).toBe('stalled');
    expect(eventEmitter.emit.mock.calls.filter(([e]) => e === 'worker.stalled')).toHaveLength(1);

    await service.beat({ evaluated: false, errors: [] }, at('2026-10-01T12:08:00Z'));
    expect(eventEmitter.emit).toHaveBeenCalledWith('worker.resumed', expect.objectContaining({ resumedAt: '2026-10-01T12:08:00.000Z' }));
  });
});
