import { FakeWorkerOfflineStore } from '../incidents/testing/fake-worker-offline.store';
import type { OpsNotice } from '../notifications/notification.types';
import { runWatchdog, type WatchdogDeps } from './heartbeat-watchdog';

/**
 * The external watchdog is what alerts while the worker process is dead (it can't alert itself).
 * Simulates successive cron runs over the same persisted state.
 */
function make(heartbeat: Record<string, unknown> | null, over: Partial<WatchdogDeps> = {}) {
  const sent: OpsNotice[] = [];
  const store = new FakeWorkerOfflineStore();
  const state = { heartbeat };
  const deps = (now: string): WatchdogDeps => ({
    loadHeartbeat: () => Promise.resolve(state.heartbeat as never),
    incidents: store as never,
    send: (n) => {
      sent.push(n);
      return Promise.resolve();
    },
    executionEnabled: true,
    timeoutSeconds: 300,
    timeZone: 'America/Sao_Paulo',
    environment: 'PRODUCTION · PAPER',
    now: new Date(now),
    ...over,
  });
  return { sent, store, state, deps };
}

const running = (lastHeartbeatAt: string) => ({
  _id: 'krypto-worker',
  status: 'running',
  lastHeartbeatAt: new Date(lastHeartbeatAt),
  lastEvaluationAt: new Date('2026-10-01T06:00:00Z'),
});

describe('heartbeat watchdog (cron)', () => {
  it('worker dead: alerts once, stays quiet while still dead, announces recovery once', async () => {
    const { sent, state, deps } = make(running('2026-10-01T06:17:42Z'));

    await expect(runWatchdog(deps('2026-10-01T06:20:00Z'))).resolves.toBe('ok'); // within timeout
    await expect(runWatchdog(deps('2026-10-01T06:35:00Z'))).resolves.toBe('offline-opened');
    await expect(runWatchdog(deps('2026-10-01T06:40:00Z'))).resolves.toBe('offline-already-reported');
    await expect(runWatchdog(deps('2026-10-01T06:45:00Z'))).resolves.toBe('offline-already-reported');

    state.heartbeat = running('2026-10-01T06:49:30Z'); // worker came back (and didn't close it itself)
    await expect(runWatchdog(deps('2026-10-01T06:50:00Z'))).resolves.toBe('recovered');
    await expect(runWatchdog(deps('2026-10-01T06:52:00Z'))).resolves.toBe('ok');

    expect(sent.map((n) => n.headline)).toEqual(['WORKER OFFLINE', 'WORKER RECOVERED']);
    expect(sent[0].fields).toEqual(
      expect.arrayContaining([
        ['Último heartbeat', expect.stringContaining('03:17:42')],
        ['Tempo sem heartbeat', '17m 18s'],
        ['Último estado', 'RUNNING (sem parada registrada)'],
      ]),
    );
  });

  it('when the worker itself already closed the incident on restart, the cron sends nothing more', async () => {
    const { sent, store, state, deps } = make(running('2026-10-01T06:17:42Z'));
    await runWatchdog(deps('2026-10-01T06:35:00Z'));
    await store.close(new Date('2026-10-01T06:49:30Z')); // done by IncidentService.onWorkerStarted
    state.heartbeat = running('2026-10-01T06:49:30Z');
    await expect(runWatchdog(deps('2026-10-01T06:50:00Z'))).resolves.toBe('ok');
    expect(sent.map((n) => n.headline)).toEqual(['WORKER OFFLINE']);
  });

  it('reports the last recorded state (e.g. a platform stop)', async () => {
    const { sent, deps } = make({ ...running('2026-10-01T06:00:00Z'), status: 'stopped', stopReason: 'SIGTERM' });
    await runWatchdog(deps('2026-10-01T07:00:00Z'));
    expect(sent[0].fields).toContainEqual(['Último estado', 'STOPPED (SIGTERM)']);
  });

  it('does nothing when execution is disabled or no heartbeat was ever written', async () => {
    await expect(runWatchdog(make(running('2026-10-01T00:00:00Z'), { executionEnabled: false }).deps('2026-10-01T12:00:00Z'))).resolves.toBe('disabled');
    await expect(runWatchdog(make(null).deps('2026-10-01T12:00:00Z'))).resolves.toBe('no-heartbeat');
  });
});
