import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { executionConfig, trendRegimeConfig } from '../config/configuration';
import { intervalToMs } from '../market-data/interval.util';
import {
  WORKER_HEARTBEAT_ID,
  WorkerDowntime,
  WorkerHeartbeat,
  WorkerHeartbeatDocument,
} from './schemas/worker-heartbeat.schema';

/** Identifies this process in the heartbeat and in evaluation claims (two can overlap during a deploy). */
export const WORKER_INSTANCE_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Prefix of every worker lifecycle log line, so they can be grepped in the Render logs. */
export const WORKER_LOG = '[KRYPTO_WORKER]';

/** At most one "loop stalled" alert per this window, so a flapping loop doesn't flood Discord. */
const STALL_ALERT_COOLDOWN_MS = 30 * 60_000;
/** A failing heartbeat write is logged at most this often. */
const WRITE_WARN_EVERY_MS = 10 * 60_000;

export type WorkerState = 'ONLINE' | 'OFFLINE' | 'STARTING' | 'DISABLED';
/** This process's own loop, as seen from inside it (used by /health and the stall watchdog). */
export type LoopState = 'disabled' | 'starting' | 'running' | 'stalled';

export interface WorkerDowntimeView {
  from: Date;
  to: Date;
  durationSeconds: number;
  lastEvaluationAt: Date | null;
  previousStopReason: string | null;
}

/** GET /bot/status `worker`: derived from the persisted heartbeat, never guessed by the client. */
export interface WorkerStatus {
  state: WorkerState;
  /** Why it is not ONLINE (e.g. "worker heartbeat expired"); null when ONLINE. */
  reason: string | null;
  instanceId: string | null;
  startedAt: Date | null;
  uptimeSeconds: number | null;
  lastHeartbeatAt: Date | null;
  lastEvaluationAt: Date | null;
  /** Close of the current strategy candle — the next evaluation happens on the first tick after it. */
  nextEvaluationAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  stoppedAt: Date | null;
  stopReason: string | null;
  heartbeatTimeoutSeconds: number;
  lastDowntime: WorkerDowntimeView | null;
}

export interface TickSummary {
  /** At least one symbol evaluated a newly closed candle this tick. */
  evaluated: boolean;
  /** Per-symbol failures of this tick (already logged by the caller). */
  errors: string[];
  /** Closed candles skipped while the worker was down, summed over symbols (0 when none). */
  missedCandles?: number;
}

/**
 * Persists the execution loop's heartbeat (worker_heartbeat) and watches it from inside the
 * process. Only MarketPollerService drives it; requests only read it (getStatus/loopState).
 */
@Injectable()
export class WorkerHeartbeatService {
  private readonly logger = new Logger('KryptoWorker');
  private loopStartedAt?: Date;
  private lastTickAt?: Date;
  private registered = false;
  private stalledSince?: Date;
  private lastStallAlertAt = 0;
  private lastWriteWarnAt = 0;
  private lastEvaluationAt?: Date;
  /** `worker.started` waits for the first tick, so it can say how many candles were missed. */
  private pendingStart?: Record<string, unknown>;

  constructor(
    @InjectModel(WorkerHeartbeat.name) private readonly model: Model<WorkerHeartbeatDocument>,
    private readonly eventEmitter: EventEmitter2,
    @Inject(executionConfig.KEY) private readonly config: ReturnType<typeof executionConfig>,
    @Inject(trendRegimeConfig.KEY) private readonly strategy: ReturnType<typeof trendRegimeConfig>,
  ) {}

  get instanceId(): string {
    return WORKER_INSTANCE_ID;
  }

  private get timeoutMs(): number {
    return this.config.workerHeartbeatTimeoutSeconds * 1000;
  }

  /** The loop's timers are armed. Persisting the start happens in registerStart (retried by beat). */
  markLoopStarted(now = new Date()): void {
    this.loopStartedAt = now;
  }

  /**
   * Records this run's start and, when the previous run's last heartbeat is older than
   * workerDowntimeAlertMinutes, the gap in between (`worker.started` carries it; notifications
   * turn it into a "worker recovered" alert). Throws when Mongo is unreachable — beat() retries.
   */
  async registerStart(now = new Date()): Promise<void> {
    const previous = await this.model.findById(WORKER_HEARTBEAT_ID).lean();
    const startedAt = this.loopStartedAt ?? now;
    let downtime: WorkerDowntime | undefined;
    if (previous?.lastHeartbeatAt) {
      const gapMs = startedAt.getTime() - new Date(previous.lastHeartbeatAt).getTime();
      if (gapMs > this.config.workerDowntimeAlertMinutes * 60_000) {
        downtime = {
          from: previous.lastHeartbeatAt,
          to: startedAt,
          lastEvaluationAt: previous.lastEvaluationAt,
          previousStopReason: previous.stoppedAt && previous.status !== 'crashed' ? previous.stopReason : undefined,
        };
      }
    }

    await this.model.updateOne(
      { _id: WORKER_HEARTBEAT_ID },
      {
        $set: {
          instanceId: WORKER_INSTANCE_ID,
          status: 'running',
          startedAt,
          lastHeartbeatAt: now,
          ...(downtime ? { lastDowntime: downtime } : {}),
        },
        $unset: { stoppedAt: 1, stopReason: 1, crashError: 1 },
      },
      { upsert: true },
    );
    this.registered = true;
    this.lastEvaluationAt = previous?.lastEvaluationAt ? new Date(previous.lastEvaluationAt) : undefined;

    this.logger.log(
      `${WORKER_LOG} started instance=${WORKER_INSTANCE_ID} symbols=${this.strategy.symbols.join(',')} ` +
        `timeframe=${this.strategy.timeframe} poll=${this.config.pollIntervalSeconds}s ` +
        `previousHeartbeat=${previous?.lastHeartbeatAt ? new Date(previous.lastHeartbeatAt).toISOString() : 'none'}`,
    );
    if (downtime) {
      const minutes = Math.round((startedAt.getTime() - new Date(downtime.from).getTime()) / 60_000);
      this.logger.warn(
        `${WORKER_LOG} recovered after downtime from=${new Date(downtime.from).toISOString()} ` +
          `to=${startedAt.toISOString()} minutes=${minutes} previousStop=${downtime.previousStopReason ?? 'unrecorded'}`,
      );
    }
    const iso = (d?: Date) => (d ? new Date(d).toISOString() : null);
    this.pendingStart = {
      instanceId: WORKER_INSTANCE_ID,
      startedAt: startedAt.toISOString(),
      previousHeartbeatAt: iso(previous?.lastHeartbeatAt),
      previous: previous
        ? {
            status: previous.status,
            stopReason: previous.stopReason ?? null,
            stoppedAt: iso(previous.stoppedAt),
            lastEvaluationAt: iso(previous.lastEvaluationAt),
            crashError: previous.crashError ?? null,
          }
        : null,
      ...(downtime ? { downtime: this.toDowntimeJson(downtime) } : {}),
    };
  }

  /** Once per loop tick, whatever happened in it (a failing tick is still a live loop). */
  async beat(summary: TickSummary, now = new Date()): Promise<void> {
    this.lastTickAt = now;
    if (this.stalledSince) {
      this.logger.log(`${WORKER_LOG} recovered loop resumed after stall since=${this.stalledSince.toISOString()}`);
      this.eventEmitter.emit('worker.resumed', { stalledSince: this.stalledSince.toISOString(), resumedAt: now.toISOString() });
      this.stalledSince = undefined;
    }

    try {
      if (!this.registered) {
        await this.registerStart(now);
      }
      if (summary.evaluated) this.lastEvaluationAt = now;
      if (this.pendingStart) {
        // Event history + incident layer (WORKER RECOVERED / RESTARTED decisions live there).
        this.eventEmitter.emit('worker.started', { ...this.pendingStart, missedCandles: summary.missedCandles ?? 0 });
        this.pendingStart = undefined;
      }
      const error = summary.errors.length ? summary.errors.join(' | ').slice(0, 1000) : undefined;
      await this.model.updateOne(
        { _id: WORKER_HEARTBEAT_ID },
        {
          $set: {
            instanceId: WORKER_INSTANCE_ID,
            status: 'running',
            lastHeartbeatAt: now,
            ...(summary.evaluated ? { lastEvaluationAt: now } : {}),
            ...(error ? { lastError: error, lastErrorAt: now } : {}),
          },
          $unset: { stoppedAt: 1, stopReason: 1 },
          $setOnInsert: { startedAt: this.loopStartedAt ?? now },
        },
        { upsert: true },
      );
    } catch (err) {
      // The loop must keep running without Mongo; the in-process lastTickAt still serves /health.
      if (now.getTime() - this.lastWriteWarnAt >= WRITE_WARN_EVERY_MS) {
        this.lastWriteWarnAt = now.getTime();
        this.logger.warn(`${WORKER_LOG} heartbeat_write_failed error="${(err as Error).message}"`);
      }
    }
  }

  /** Clean shutdown (SIGTERM etc.). Only marks the document if this process wrote it last. */
  async markStopped(reason: string, now = new Date()): Promise<void> {
    this.logger.warn(`${WORKER_LOG} stopping reason=${reason} instance=${WORKER_INSTANCE_ID}`);
    try {
      await this.model.updateOne(
        { _id: WORKER_HEARTBEAT_ID, instanceId: WORKER_INSTANCE_ID },
        { $set: { status: 'stopped', stoppedAt: now, stopReason: reason } },
      );
    } catch (err) {
      this.logger.warn(`${WORKER_LOG} could not record the stop: ${(err as Error).message}`);
    }
  }

  /**
   * uncaughtException: recorded so the next run can say "restarted after a crash" instead of
   * guessing. Bounded (the process is about to exit) and never throws.
   */
  async markCrashed(error: string, timeoutMs = 2_000, now = new Date()): Promise<void> {
    await Promise.race([
      this.model
        .updateOne(
          { _id: WORKER_HEARTBEAT_ID, instanceId: WORKER_INSTANCE_ID },
          { $set: { status: 'crashed', stoppedAt: now, stopReason: 'uncaughtException', crashError: error.slice(0, 300) } },
        )
        .catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  /** In-process view of this process's loop. `stalled` = enabled, started, but no tick for heartbeatTimeout. */
  loopState(now = Date.now()): LoopState {
    if (!this.config.enabled) return 'disabled';
    if (!this.loopStartedAt) return 'starting';
    const reference = (this.lastTickAt ?? this.loopStartedAt).getTime();
    if (now - reference > this.timeoutMs) return 'stalled';
    return this.lastTickAt ? 'running' : 'starting';
  }

  getLastTickAt(): Date | null {
    return this.lastTickAt ?? null;
  }

  /** Called by the loop's watchdog timer (independent of the tick, so it fires even if a tick hangs). */
  checkStall(now = new Date()): void {
    if (this.loopState(now.getTime()) !== 'stalled' || this.stalledSince) return;
    this.stalledSince = now;
    const last = (this.lastTickAt ?? this.loopStartedAt)!.toISOString();
    this.logger.error(`${WORKER_LOG} stalled no tick since=${last} timeout=${this.config.workerHeartbeatTimeoutSeconds}s`);
    if (now.getTime() - this.lastStallAlertAt < STALL_ALERT_COOLDOWN_MS) return;
    this.lastStallAlertAt = now.getTime();
    this.eventEmitter.emit('worker.stalled', {
      lastTickAt: last,
      detectedAt: now.toISOString(),
      lastEvaluationAt: this.lastEvaluationAt?.toISOString() ?? null,
    });
  }

  /** For GET /bot/status: everything comes from the persisted document written by the loop. */
  async getStatus(now = new Date()): Promise<WorkerStatus> {
    const doc = await this.model.findById(WORKER_HEARTBEAT_ID).lean();
    const nowMs = now.getTime();
    const date = (d?: Date | null) => (d ? new Date(d) : null);
    const lastHeartbeatAt = date(doc?.lastHeartbeatAt);

    let state: WorkerState;
    let reason: string | null = null;
    if (!this.config.enabled) {
      state = 'DISABLED';
      reason = 'EXECUTION_ENABLED=false';
    } else if (!doc || !lastHeartbeatAt) {
      state = 'STARTING';
      reason = 'no heartbeat recorded yet';
    } else if (doc.status === 'crashed') {
      state = 'OFFLINE';
      reason = 'worker crashed';
    } else if (doc.status === 'stopped') {
      state = 'OFFLINE';
      reason = `worker stopped (${doc.stopReason ?? 'unknown'})`;
    } else if (nowMs - lastHeartbeatAt.getTime() > this.timeoutMs) {
      state = 'OFFLINE';
      reason = 'worker heartbeat expired';
    } else {
      state = 'ONLINE';
    }

    const startedAt = date(doc?.startedAt);
    const tfMs = intervalToMs(this.strategy.timeframe);
    return {
      state,
      reason,
      instanceId: doc?.instanceId ?? null,
      startedAt,
      uptimeSeconds: state === 'ONLINE' && startedAt ? Math.round((nowMs - startedAt.getTime()) / 1000) : null,
      lastHeartbeatAt,
      lastEvaluationAt: date(doc?.lastEvaluationAt),
      nextEvaluationAt: state === 'ONLINE' ? new Date(Math.floor(nowMs / tfMs) * tfMs + tfMs) : null,
      lastErrorAt: date(doc?.lastErrorAt),
      lastError: doc?.lastError ?? null,
      stoppedAt: date(doc?.stoppedAt),
      stopReason: doc?.stopReason ?? null,
      heartbeatTimeoutSeconds: this.config.workerHeartbeatTimeoutSeconds,
      lastDowntime: doc?.lastDowntime ? this.toDowntimeView(doc.lastDowntime) : null,
    };
  }

  private toDowntimeView(d: WorkerDowntime): WorkerDowntimeView {
    const from = new Date(d.from);
    const to = new Date(d.to);
    return {
      from,
      to,
      durationSeconds: Math.round((to.getTime() - from.getTime()) / 1000),
      lastEvaluationAt: d.lastEvaluationAt ? new Date(d.lastEvaluationAt) : null,
      previousStopReason: d.previousStopReason ?? null,
    };
  }

  private toDowntimeJson(d: WorkerDowntime) {
    const v = this.toDowntimeView(d);
    return {
      from: v.from.toISOString(),
      to: v.to.toISOString(),
      durationSeconds: v.durationSeconds,
      lastEvaluationAt: v.lastEvaluationAt?.toISOString() ?? null,
      previousStopReason: v.previousStopReason,
    };
  }
}
