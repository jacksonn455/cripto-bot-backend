import { Logger } from '@nestjs/common';
import type { Notification, OpsNotice } from '../notifications/notification.types';
import { sanitizeForAlert } from './incident-format.util';
import { IncidentService, type WorkerStartedEvent } from './incident.service';
import { FakeWorkerOfflineStore } from './testing/fake-worker-offline.store';

const CONFIG = {
  timeZone: 'America/Sao_Paulo',
  alertCooldownSeconds: 300,
  incidentFailureThreshold: 3,
  environment: 'PRODUCTION',
};

function make(config: Partial<typeof CONFIG> = {}) {
  const sent: OpsNotice[] = [];
  const notifications = {
    dispatch: jest.fn((n: Notification) => {
      if (n.kind === 'ops') sent.push(n.notice);
      return Promise.resolve();
    }),
  };
  const store = new FakeWorkerOfflineStore();
  const service = new IncidentService(
    notifications as never,
    { ...CONFIG, ...config } as never,
    { mode: 'PAPER' } as never,
    store as never,
  );
  return { service, sent, store, notifications };
}

const t = (iso: string) => new Date(iso);
const binance = (error: unknown = new Error('timeout of 15000ms exceeded')) => ({
  key: 'MARKET_DATA:BTCUSDT',
  type: 'MARKET_DATA_ERROR',
  component: 'Binance API (market data)',
  error,
  symbol: 'BTCUSDT',
});
const field = (n: OpsNotice, name: string) => n.fields.find(([k]) => k === name)?.[1];
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('IncidentService — component incidents', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('a recoverable error only becomes an incident after N consecutive failures (one message)', () => {
    const { service, sent } = make();
    service.reportFailure(binance(), t('2026-10-01T05:41:00Z'));
    service.reportFailure(binance(), t('2026-10-01T05:42:00Z'));
    expect(sent).toHaveLength(0);

    service.reportFailure(binance(), t('2026-10-01T05:43:00Z'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ phase: 'incident', headline: 'INCIDENT', severity: 'warning', incidentKey: 'MARKET_DATA:BTCUSDT' });
    expect(field(sent[0], 'Componente')).toBe('Binance API (market data)');
    expect(field(sent[0], 'Símbolo')).toBe('BTCUSDT');
    expect(field(sent[0], 'Tentativas')).toBe('3');
    expect(field(sent[0], 'Início')).toContain('02:41:00'); // first failure, in UTC-3
    expect(field(sent[0], 'Ambiente')).toBe('PRODUCTION · PAPER');
  });

  it('a quick recovery before the threshold sends nothing at all', () => {
    const { service, sent } = make();
    service.reportFailure(binance());
    service.reportFailure(binance());
    service.reportSuccess('MARKET_DATA:BTCUSDT');
    service.reportFailure(binance());
    service.reportFailure(binance());
    expect(sent).toHaveLength(0);
  });

  it('critical problems alert on the first failure', () => {
    const { service, sent } = make();
    service.reportFailure({ key: 'DATABASE', type: 'DATABASE_ERROR', component: 'MongoDB', error: new Error('ECONNREFUSED'), critical: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ severity: 'critical' });
    expect(field(sent[0], 'Status')).toBe('DOWN');
  });

  it('the same error while the incident is active is NOT sent again', () => {
    const { service, sent } = make();
    for (let i = 0; i < 30; i++) service.reportFailure(binance(), new Date(Date.UTC(2026, 9, 1, 6, i)));
    expect(sent).toHaveLength(1);
    expect(service.getActive()).toHaveLength(1);
  });

  it('recovery sends one RECOVERED with start, end and duration', () => {
    const { service, sent } = make();
    for (const m of [0, 1, 2]) service.reportFailure(binance(), new Date(Date.UTC(2026, 9, 1, 6, 0 + m)));
    service.reportSuccess('MARKET_DATA:BTCUSDT', t('2026-10-01T06:01:44Z'));
    service.reportSuccess('MARKET_DATA:BTCUSDT', t('2026-10-01T06:02:44Z')); // already recovered: nothing

    expect(sent.map((n) => n.phase)).toEqual(['incident', 'recovery']);
    expect(sent[1]).toMatchObject({ headline: 'RECOVERED' });
    expect(field(sent[1], 'Status')).toBe('OPERATIONAL');
    expect(field(sent[1], 'Duração')).toBe('1m 44s');
    expect(field(sent[1], 'Tipo')).toBe('MARKET_DATA_RECOVERED');
    expect(service.getActive()).toHaveLength(0);
  });

  it('the same problem coming back after a recovery is a new, independent incident', () => {
    const { service, sent } = make();
    const down = (base: number) => [0, 1, 2].forEach((m) => service.reportFailure(binance(), new Date(base + m * 60_000)));
    const t0 = Date.UTC(2026, 9, 1, 6, 0);
    down(t0); // 06:00
    service.reportSuccess('MARKET_DATA:BTCUSDT', new Date(t0 + 4 * 60_000)); // 06:04
    down(t0 + 20 * 60_000); // 06:20
    service.reportSuccess('MARKET_DATA:BTCUSDT', new Date(t0 + 25 * 60_000)); // 06:25

    expect(sent.map((n) => n.phase)).toEqual(['incident', 'recovery', 'incident', 'recovery']);
  });

  it('cooldown: a relapse right after recovering is tracked but not re-sent (nor its recovery)', () => {
    const { service, sent } = make({ alertCooldownSeconds: 300 });
    const t0 = Date.UTC(2026, 9, 1, 6, 0);
    [0, 1, 2].forEach((s) => service.reportFailure(binance(), new Date(t0 + s * 1000)));
    service.reportSuccess('MARKET_DATA:BTCUSDT', new Date(t0 + 30_000));
    [0, 1, 2].forEach((s) => service.reportFailure(binance(), new Date(t0 + 60_000 + s * 1000)));
    expect(service.getActive()[0]).toMatchObject({ notificationSent: false });
    service.reportSuccess('MARKET_DATA:BTCUSDT', new Date(t0 + 90_000));

    expect(sent.map((n) => n.phase)).toEqual(['incident', 'recovery']);
  });

  it('never puts secrets or stack traces in the message', () => {
    const { service, sent } = make();
    const err = new Error(
      'MongoServerSelectionError: connect to mongodb+srv://bot:S3cr3tPass@cluster0.abc.mongodb.net/cripto-bot-paper?retryWrites=true failed; ' +
        'webhook https://discord.com/api/webhooks/123/abcDEF_token apiKey=AKIAXYZ123',
    );
    err.stack = `${err.message}\n    at Connection.connect (/app/node_modules/mongodb/lib/x.js:1:1)`;
    service.reportFailure({ key: 'DATABASE', type: 'DATABASE_ERROR', component: 'MongoDB', error: err, critical: true });

    const text = JSON.stringify(sent[0]);
    expect(text).not.toContain('S3cr3tPass');
    expect(text).not.toContain('bot:');
    expect(text).not.toContain('abcDEF_token');
    expect(text).not.toContain('AKIAXYZ123');
    expect(text).not.toContain('node_modules');
    expect(text).toContain('mongodb+srv://cluster0.abc.mongodb.net');
  });

  it('one-off events (unhandled rejection) are deduplicated by the cooldown', () => {
    const { service, sent } = make();
    const ev = { key: 'UNHANDLED_REJECTION:x', type: 'UNHANDLED_ERROR', component: 'Processo', error: new Error('x') };
    service.reportEvent(ev, t('2026-10-01T06:00:00Z'));
    service.reportEvent(ev, t('2026-10-01T06:01:00Z'));
    service.reportEvent(ev, t('2026-10-01T06:06:00Z'));
    expect(sent).toHaveLength(2);
  });

  it('reportCrash never waits longer than its timeout', async () => {
    const { service, notifications } = make();
    notifications.dispatch.mockReturnValue(new Promise(() => undefined)); // Discord hangs
    const start = Date.now();
    await service.reportCrash(new Error('boom'), 50);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe('IncidentService — worker lifecycle', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const started = (over: Partial<WorkerStartedEvent> = {}): WorkerStartedEvent => ({
    instanceId: 'new',
    startedAt: '2026-10-01T12:14:22.000Z',
    previousHeartbeatAt: '2026-10-01T12:13:50.000Z',
    previous: { status: 'stopped', stopReason: 'SIGTERM', stoppedAt: '2026-10-01T12:13:55.000Z', lastEvaluationAt: '2026-10-01T12:00:30.000Z', crashError: null },
    missedCandles: 0,
    ...over,
  });

  it('loop stalled → one WORKER OFFLINE; resumed → WORKER RECOVERED', async () => {
    const { service, sent } = make();
    const stall = { lastTickAt: '2026-10-01T06:17:42.000Z', detectedAt: '2026-10-01T06:35:42.000Z', lastEvaluationAt: '2026-10-01T06:00:00.000Z' };
    await service.onWorkerStalled(stall);
    await service.onWorkerStalled(stall); // already ACTIVE: no second message
    await service.onWorkerResumed({ stalledSince: stall.detectedAt, resumedAt: '2026-10-01T06:43:12.000Z' });
    await settle();

    expect(sent.map((n) => n.headline)).toEqual(['WORKER OFFLINE', 'WORKER RECOVERED']);
    expect(field(sent[0], 'Último heartbeat')).toContain('03:17:42');
    expect(field(sent[0], 'Última avaliação')).toContain('03:00:00');
    expect(field(sent[0], 'Tempo sem heartbeat')).toBe('18m');
    expect(field(sent[1], 'Tempo indisponível')).toBe('25m 30s');
  });

  it('start after the cron watchdog reported it offline → WORKER RECOVERED with missed candles', async () => {
    const { service, sent, store } = make();
    await store.open({ startedAt: t('2026-10-01T06:17:42Z'), lastHeartbeatAt: t('2026-10-01T06:17:42Z'), lastEvaluationAt: t('2026-10-01T06:00:00Z'), detectedBy: 'heartbeat-watchdog-cron' });
    await store.markNotified();

    await service.onWorkerStarted(started({ startedAt: '2026-10-01T06:25:12.000Z', previous: null, missedCandles: 2 }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ phase: 'recovery', headline: 'WORKER RECOVERED' });
    expect(field(sent[0], 'Tempo indisponível')).toBe('7m 30s');
    expect(field(sent[0], 'Avaliações perdidas')).toMatch(/^2 candle/);
    expect(store.record?.status).toBe('RECOVERED');
  });

  it('start after a long gap nobody reported → WORKER RECOVERED (outage detected at restart)', async () => {
    const { service, sent } = make();
    await service.onWorkerStarted(
      started({
        previous: { status: 'running', stopReason: null, stoppedAt: null, lastEvaluationAt: '2026-10-01T01:00:00.000Z', crashError: null },
        downtime: { from: '2026-10-01T01:45:00.000Z', to: '2026-10-01T12:02:00.000Z', durationSeconds: 37_020, lastEvaluationAt: '2026-10-01T01:00:00.000Z', previousStopReason: null },
        startedAt: '2026-10-01T12:02:00.000Z',
        missedCandles: 20,
      }),
    );
    expect(sent[0]).toMatchObject({ headline: 'WORKER RECOVERED' });
    expect(field(sent[0], 'Tempo indisponível')).toBe('10h 17m');
    expect(sent[0].summary).toContain('sem parada registrada');
  });

  it('start after a recorded crash → RESTARTED (previous CRASHED, current ONLINE)', async () => {
    const { service, sent } = make();
    await service.onWorkerStarted(
      started({ previous: { status: 'crashed', stopReason: 'uncaughtException', stoppedAt: '2026-10-01T12:14:00.000Z', lastEvaluationAt: null, crashError: 'TypeError: x' } }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ phase: 'restart', headline: 'RESTARTED' });
    expect(field(sent[0], 'Status anterior')).toBe('CRASHED');
    expect(field(sent[0], 'Status atual')).toBe('ONLINE');
    expect(field(sent[0], 'Iniciado')).toContain('09:14:22');
  });

  it('a clean deploy (SIGTERM, short gap) or a first-ever start sends nothing', async () => {
    const { service, sent } = make();
    await service.onWorkerStarted(started());
    await service.onWorkerStarted(started({ previous: null, previousHeartbeatAt: null }));
    expect(sent).toHaveLength(0);
  });

  it('start → stop → restart sequence: only the restart after a crash is announced', async () => {
    const { service, sent } = make();
    await service.onWorkerStarted(started({ previous: null })); // first start
    await service.onWorkerStarted(started()); // deploy (clean SIGTERM before)
    await service.onWorkerStarted(started({ previous: { status: 'crashed', stopReason: 'uncaughtException', stoppedAt: null, lastEvaluationAt: null, crashError: 'boom' } }));
    expect(sent.map((n) => n.headline)).toEqual(['RESTARTED']);
  });
});

describe('sanitizeForAlert', () => {
  it('keeps the operational meaning, drops credentials, tokens and stacks', () => {
    expect(sanitizeForAlert(new Error('Binance API error (HTTP 429): too many requests'))).toBe('Binance API error (HTTP 429): too many requests');
    expect(sanitizeForAlert('rediss://default:tok3n@eu1.upstash.io:6379 refused')).toBe('rediss://eu1.upstash.io:6379 refused');
    expect(sanitizeForAlert('GET /api/v3/order?symbol=BTCUSDT&signature=abcdef0123 failed')).toBe('GET /api/v3/order?symbol=BTCUSDT&signature=*** failed');
    expect(sanitizeForAlert('Authorization: Bearer eyJhbGciOi.payload.sig')).not.toContain('eyJ');
    expect(sanitizeForAlert('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
    expect(sanitizeForAlert('line1\n    at stack (file.js:1:1)')).toBe('line1');
  });
});
