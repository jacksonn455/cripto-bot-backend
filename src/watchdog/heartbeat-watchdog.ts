import mongoose, { type Model } from 'mongoose';
import { executionConfig, notificationsConfig, tradingConfig } from '../config/configuration';
import {
  WORKER_HEARTBEAT_ID,
  WorkerHeartbeat,
  WorkerHeartbeatSchema,
  type WorkerHeartbeatDocument,
} from '../control/schemas/worker-heartbeat.schema';
import { formatClock } from '../incidents/incident-format.util';
import { workerOfflineNotice, workerRecoveredNotice } from '../incidents/incident.service';
import { IncidentRecord, IncidentRecordSchema, type IncidentRecordDocument } from '../incidents/schemas/incident.schema';
import { WorkerOfflineIncidentStore } from '../incidents/worker-offline-incident.store';
import { DiscordNotificationProvider } from '../notifications/discord/discord-notification.provider';
import type { OpsNotice } from '../notifications/notification.types';
import { NotificationsService } from '../notifications/notifications.service';
import { TelegramNotificationProvider } from '../notifications/telegram/telegram-notification.provider';

/**
 * External heartbeat watchdog — run as a separate, short-lived process (Render Cron Job, every
 * few minutes). It exists because a dead or sleeping worker cannot report its own death: this
 * reads the heartbeat the worker persists and, if it is older than WORKER_HEARTBEAT_TIMEOUT_SECONDS,
 * opens the shared WORKER_OFFLINE incident and sends one "WORKER OFFLINE" message. It never runs
 * the strategy and never touches trading state. The worker closes the incident (WORKER RECOVERED)
 * when it comes back; this only closes it as a fallback if the worker is fresh but didn't.
 */

export type WatchdogResult = 'disabled' | 'no-heartbeat' | 'ok' | 'offline-opened' | 'offline-already-reported' | 'recovered';

export interface WatchdogDeps {
  /** Reads the worker_heartbeat singleton. */
  loadHeartbeat: () => Promise<WorkerHeartbeat | null>;
  incidents: WorkerOfflineIncidentStore;
  send: (notice: OpsNotice) => Promise<void>;
  executionEnabled: boolean;
  timeoutSeconds: number;
  timeZone: string;
  environment: string;
  now?: Date;
}

export async function runWatchdog(d: WatchdogDeps): Promise<WatchdogResult> {
  if (!d.executionEnabled) return 'disabled';
  const now = d.now ?? new Date();
  const hb = await d.loadHeartbeat();
  if (!hb?.lastHeartbeatAt) return 'no-heartbeat';
  const last = new Date(hb.lastHeartbeatAt);
  const stale = now.getTime() - last.getTime() > d.timeoutSeconds * 1000;
  const clock = (x: Date) => formatClock(x, d.timeZone);

  if (stale) {
    const lastStatus =
      hb.status === 'stopped'
        ? `STOPPED (${hb.stopReason ?? 'n/d'})`
        : hb.status === 'crashed'
          ? `CRASHED (${hb.crashError ?? 'n/d'})`
          : 'RUNNING (sem parada registrada)';
    const opened = await d.incidents.open({
      startedAt: last,
      detectedBy: 'heartbeat-watchdog-cron',
      lastHeartbeatAt: last,
      lastEvaluationAt: hb.lastEvaluationAt ? new Date(hb.lastEvaluationAt) : undefined,
      lastWorkerStatus: lastStatus,
    });
    if (!opened) return 'offline-already-reported';
    await d.send(
      workerOfflineNotice({
        lastHeartbeatAt: last,
        lastEvaluationAt: hb.lastEvaluationAt ? new Date(hb.lastEvaluationAt) : null,
        lastStatus,
        now,
        environment: d.environment,
        clock,
      }),
    );
    await d.incidents.markNotified();
    return 'offline-opened';
  }

  const closed = await d.incidents.close(now);
  if (!closed) return 'ok';
  if (closed.notificationSent) {
    await d.send(
      workerRecoveredNotice({
        from: closed.lastHeartbeatAt ?? closed.startedAt,
        to: last,
        lastEvaluationAt: hb.lastEvaluationAt ? new Date(hb.lastEvaluationAt) : null,
        missedCandles: null,
        how: 'heartbeat voltou (detectado pelo watchdog externo)',
        environment: d.environment,
        clock,
      }),
    );
  }
  return 'recovered';
}

async function main(): Promise<void> {
  const notifications = notificationsConfig();
  const execution = executionConfig();
  const trading = tradingConfig();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is required');

  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15_000 }).asPromise();
  try {
    const discord = new DiscordNotificationProvider(notifications);
    const telegram = new TelegramNotificationProvider(notifications);
    const service = new NotificationsService([telegram, discord]);
    const result = await runWatchdog({
      loadHeartbeat: () =>
        (conn.model(WorkerHeartbeat.name, WorkerHeartbeatSchema) as unknown as Model<WorkerHeartbeatDocument>)
          .findById(WORKER_HEARTBEAT_ID)
          .lean<WorkerHeartbeat>(),
      incidents: new WorkerOfflineIncidentStore(
        conn.model(IncidentRecord.name, IncidentRecordSchema) as unknown as Model<IncidentRecordDocument>,
      ),
      send: (notice) => service.dispatch({ kind: 'ops', notice }),
      executionEnabled: execution.enabled,
      timeoutSeconds: execution.workerHeartbeatTimeoutSeconds,
      timeZone: notifications.timeZone,
      environment: `${notifications.environment} · ${trading.mode}`,
    });
    console.log(`[KRYPTO_WATCHDOG] result=${result}`);
  } finally {
    await conn.close();
  }
}

if (require.main === module) {
  main().catch((err: Error) => {
    // Credentials can appear in driver errors; keep only the message, masked.
    console.error(`[KRYPTO_WATCHDOG] failed: ${err.message.replace(/\/\/[^@\s/]*@/g, '//***@')}`);
    process.exit(1);
  });
}
