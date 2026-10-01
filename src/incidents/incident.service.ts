import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { notificationsConfig, tradingConfig } from '../config/configuration';
import type { OpsNotice } from '../notifications/notification.types';
import { NotificationsService } from '../notifications/notifications.service';
import { formatClock, formatSpan, sanitizeForAlert } from './incident-format.util';
import { WORKER_OFFLINE_STORE } from './incident.tokens';
import type { WorkerOfflineIncidentStore } from './worker-offline-incident.store';

export const INCIDENT_LOG = '[KRYPTO_INCIDENT]';

export interface IncidentState {
  key: string;
  type: string;
  component: string;
  status: 'ACTIVE' | 'RECOVERED';
  startedAt: Date;
  recoveredAt?: Date;
  lastError?: string;
  /** Consecutive failed checks (while ACTIVE: since it opened). */
  failures: number;
  /** False when the cooldown suppressed the Discord message (its recovery is then not sent either). */
  notificationSent: boolean;
  symbol?: string;
  critical: boolean;
}

export interface FailureReport {
  /** Stable identity, e.g. `MARKET_DATA:BTCUSDT`, `DATABASE`. */
  key: string;
  /** e.g. MARKET_DATA_ERROR, DATABASE_ERROR. Recovery type = same with _RECOVERED. */
  type: string;
  /** Human component name, e.g. "Binance API (market data)". */
  component: string;
  error: unknown;
  symbol?: string;
  /** Critical = alert on the first failure (process/database/scheduler). Default: after N consecutive. */
  critical?: boolean;
}

/** Payload of `worker.started` (WorkerHeartbeatService), emitted after the first tick of a run. */
export interface WorkerStartedEvent {
  instanceId: string;
  startedAt: string;
  previousHeartbeatAt: string | null;
  previous: {
    status: string;
    stopReason: string | null;
    stoppedAt: string | null;
    lastEvaluationAt: string | null;
    crashError: string | null;
  } | null;
  downtime?: { from: string; to: string; durationSeconds: number; lastEvaluationAt: string | null; previousStopReason: string | null };
  /** Closed candles not evaluated in real time (summed over symbols), from the first tick. */
  missedCandles: number | null;
}

/**
 * Operational incident manager. Errors are logged where they happen (full technical detail);
 * this turns them into, at most, one "incident" and one "recovery" message per occurrence:
 *
 *   failure → (N consecutive, or 1 if critical) → INCIDENT ─ more failures: nothing ─ success → RECOVERED
 *
 * A component that fails again after recovering is a new incident; if that happens within the
 * cooldown, it is tracked and logged but not re-sent (anti-flap). Component state lives in memory
 * (a restart starts clean); the worker-offline incident is persisted (WorkerOfflineIncidentStore),
 * because the process that recovers is not the one that went down.
 */
@Injectable()
export class IncidentService {
  private readonly logger = new Logger('KryptoIncidents');
  private readonly incidents = new Map<string, IncidentState>();
  /** Failures counted before the threshold opens an incident. */
  private readonly pending = new Map<string, { count: number; firstAt: Date; lastError: string }>();
  private readonly lastNotifiedAt = new Map<string, number>();

  constructor(
    private readonly notifications: NotificationsService,
    @Inject(notificationsConfig.KEY) private readonly config: ReturnType<typeof notificationsConfig>,
    @Inject(tradingConfig.KEY) private readonly trading: ReturnType<typeof tradingConfig>,
    @Optional() @Inject(WORKER_OFFLINE_STORE) private readonly workerOffline?: WorkerOfflineIncidentStore,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Component incidents

  reportFailure(report: FailureReport, now = new Date()): void {
    const message = report.error instanceof Error ? report.error.message : String(report.error);
    const active = this.incidents.get(report.key);
    if (active?.status === 'ACTIVE') {
      active.failures += 1;
      active.lastError = sanitizeForAlert(report.error);
      return; // deduplicated: the incident message already went out
    }

    const p = this.pending.get(report.key) ?? { count: 0, firstAt: now, lastError: message };
    p.count += 1;
    p.lastError = message;
    this.pending.set(report.key, p);
    const threshold = report.critical ? 1 : this.config.incidentFailureThreshold;
    if (p.count < threshold) {
      this.logger.warn(`${INCIDENT_LOG} failure key=${report.key} attempt=${p.count}/${threshold} error="${message}"`);
      return;
    }

    this.pending.delete(report.key);
    const state: IncidentState = {
      key: report.key,
      type: report.type,
      component: report.component,
      status: 'ACTIVE',
      startedAt: p.firstAt,
      lastError: sanitizeForAlert(report.error),
      failures: p.count,
      notificationSent: false,
      symbol: report.symbol,
      critical: Boolean(report.critical),
    };
    this.incidents.set(report.key, state);

    if (!this.cooldownAllows(report.key, now)) {
      this.logger.error(
        `${INCIDENT_LOG} opened key=${report.key} type=${report.type} attempts=${p.count} error="${message}" (notification suppressed: cooldown)`,
      );
      return;
    }
    state.notificationSent = true;
    this.lastNotifiedAt.set(report.key, now.getTime());
    this.logger.error(`${INCIDENT_LOG} opened key=${report.key} type=${report.type} attempts=${p.count} error="${message}"`);
    this.send({
      phase: 'incident',
      headline: 'INCIDENT',
      summary: `${report.component}${report.symbol ? ` · ${report.symbol}` : ''}: ${state.lastError}`,
      severity: report.critical ? 'critical' : 'warning',
      fields: [
        ['Componente', report.component],
        ['Status', report.critical ? 'DOWN' : 'DEGRADED'],
        ['Tipo', report.type],
        ['Problema', state.lastError ?? 'n/d'],
        ...(report.symbol ? ([['Símbolo', report.symbol]] as Array<[string, string]>) : []),
        ['Tentativas', String(p.count)],
        ['Início', this.clock(p.firstAt)],
        ['Ambiente', this.environment],
      ],
      incidentKey: report.key,
      at: now.toISOString(),
    });
  }

  reportSuccess(key: string, now = new Date()): void {
    this.pending.delete(key);
    const state = this.incidents.get(key);
    if (state?.status !== 'ACTIVE') return;
    state.status = 'RECOVERED';
    state.recoveredAt = now;
    const duration = now.getTime() - state.startedAt.getTime();
    this.logger.log(`${INCIDENT_LOG} recovered key=${key} type=${state.type} duration=${formatSpan(duration)} failures=${state.failures}`);
    if (!state.notificationSent) return; // its incident message was suppressed: don't send a lone recovery
    this.send({
      phase: 'recovery',
      headline: 'RECOVERED',
      summary: `${state.component}${state.symbol ? ` · ${state.symbol}` : ''} voltou a operar normalmente.`,
      severity: 'info',
      fields: [
        ['Componente', state.component],
        ['Status', 'OPERATIONAL'],
        ['Tipo', state.type.replace(/_ERROR$/, '_RECOVERED')],
        ['Início', this.clock(state.startedAt)],
        ['Recuperado', this.clock(now)],
        ['Duração', formatSpan(duration)],
        ['Falhas no período', String(state.failures)],
        ['Ambiente', this.environment],
      ],
      incidentKey: key,
      at: now.toISOString(),
    });
  }

  /** A one-off problem with no "recovered" counterpart (e.g. an unhandled rejection). Cooldown per key. */
  reportEvent(report: FailureReport, now = new Date()): void {
    const message = report.error instanceof Error ? report.error.message : String(report.error);
    if (!this.cooldownAllows(report.key, now)) {
      this.logger.error(`${INCIDENT_LOG} event key=${report.key} error="${message}" (notification suppressed: cooldown)`);
      return;
    }
    this.lastNotifiedAt.set(report.key, now.getTime());
    this.logger.error(`${INCIDENT_LOG} event key=${report.key} type=${report.type} error="${message}"`);
    this.send({
      phase: 'incident',
      headline: 'INCIDENT',
      summary: `${report.component}: ${sanitizeForAlert(report.error)}`,
      severity: report.critical ? 'critical' : 'warning',
      fields: [
        ['Componente', report.component],
        ['Tipo', report.type],
        ['Problema', sanitizeForAlert(report.error)],
        ['Quando', this.clock(now)],
        ['Ambiente', this.environment],
      ],
      incidentKey: report.key,
      at: now.toISOString(),
    });
  }

  /**
   * uncaughtException: the process is about to exit (the host restarts it). Best effort, bounded:
   * never delays the exit by more than `timeoutMs`.
   */
  async reportCrash(error: unknown, timeoutMs = 3_000, now = new Date()): Promise<void> {
    this.logger.error(`${INCIDENT_LOG} process_crash error="${error instanceof Error ? error.stack : String(error)}"`);
    const notice: OpsNotice = {
      phase: 'incident',
      headline: 'PROCESS CRASHED',
      summary: `Erro não tratado derrubou o processo do Krypto; a plataforma deve reiniciá-lo.`,
      severity: 'critical',
      fields: [
        ['Componente', 'Processo do backend/worker'],
        ['Tipo', 'UNHANDLED_ERROR'],
        ['Problema', sanitizeForAlert(error)],
        ['Quando', this.clock(now)],
        ['Ambiente', this.environment],
      ],
      incidentKey: 'PROCESS',
      at: now.toISOString(),
    };
    await Promise.race([
      this.notifications.dispatch({ kind: 'ops', notice }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  getActive(): IncidentState[] {
    return [...this.incidents.values()].filter((i) => i.status === 'ACTIVE');
  }

  // ---------------------------------------------------------------------------------------------
  // Worker lifecycle (events from WorkerHeartbeatService)

  /** Loop stopped ticking inside a live process. Shares the persisted incident with the cron watchdog. */
  @OnEvent('worker.stalled')
  async onWorkerStalled(payload: { lastTickAt: string; detectedAt: string; lastEvaluationAt?: string | null }): Promise<void> {
    const opened = await this.openWorkerOffline({
      startedAt: new Date(payload.lastTickAt),
      detectedBy: 'in-process-watchdog',
      lastHeartbeatAt: new Date(payload.lastTickAt),
      lastEvaluationAt: payload.lastEvaluationAt ? new Date(payload.lastEvaluationAt) : undefined,
      lastWorkerStatus: 'RUNNING (loop parado)',
    });
    if (!opened) return;
    const now = new Date(payload.detectedAt);
    this.logger.error(`${INCIDENT_LOG} opened key=WORKER_OFFLINE detectedBy=in-process-watchdog lastTick=${payload.lastTickAt}`);
    this.send(
      workerOfflineNotice({
        lastHeartbeatAt: new Date(payload.lastTickAt),
        lastEvaluationAt: payload.lastEvaluationAt ? new Date(payload.lastEvaluationAt) : null,
        lastStatus: 'RUNNING (processo vivo, loop parado)',
        now,
        environment: this.environment,
        clock: (d) => this.clock(d),
      }),
    );
    await this.workerOffline?.markNotified().catch(() => undefined);
  }

  @OnEvent('worker.resumed')
  async onWorkerResumed(payload: { stalledSince: string; resumedAt: string }): Promise<void> {
    const closed = await this.workerOffline?.close(new Date(payload.resumedAt)).catch(() => null);
    if (!closed?.notificationSent) return;
    this.send(
      workerRecoveredNotice({
        from: closed.lastHeartbeatAt ?? closed.startedAt,
        to: new Date(payload.resumedAt),
        lastEvaluationAt: closed.lastEvaluationAt ?? null,
        missedCandles: null,
        how: 'loop de execução voltou a rodar no mesmo processo',
        environment: this.environment,
        clock: (d) => this.clock(d),
      }),
    );
  }

  /**
   * A worker run started (emitted after its first tick, so missed candles are known). Decides,
   * from evidence only, which message — if any — to send:
   *  - an open WORKER_OFFLINE incident (watchdog alerted) → WORKER RECOVERED;
   *  - a heartbeat gap above WORKER_DOWNTIME_ALERT_MINUTES → WORKER RECOVERED (outage seen at restart);
   *  - the previous run recorded a crash → RESTARTED;
   *  - otherwise (first start, clean deploy) → nothing, only the log.
   */
  @OnEvent('worker.started')
  async onWorkerStarted(e: WorkerStartedEvent): Promise<void> {
    const startedAt = new Date(e.startedAt);
    const closed = await this.workerOffline?.close(startedAt).catch(() => null);
    const missed = e.missedCandles;

    if (closed?.notificationSent || e.downtime) {
      const from = closed?.lastHeartbeatAt ?? (e.downtime ? new Date(e.downtime.from) : closed!.startedAt);
      const prevStop = e.downtime?.previousStopReason ?? e.previous?.stopReason ?? null;
      this.logger.warn(`${INCIDENT_LOG} recovered key=WORKER_OFFLINE downtime=${formatSpan(startedAt.getTime() - new Date(from).getTime())}`);
      this.send(
        workerRecoveredNotice({
          from: new Date(from),
          to: startedAt,
          lastEvaluationAt: closed?.lastEvaluationAt ?? (e.downtime?.lastEvaluationAt ? new Date(e.downtime.lastEvaluationAt) : null),
          missedCandles: missed,
          how: prevStop
            ? `processo encerrado (${prevStop}) e iniciado novamente`
            : e.previous?.status === 'crashed'
              ? 'processo caiu por erro e foi reiniciado'
              : 'processo sumiu sem parada registrada (crash, hibernação ou falta de recurso) e foi iniciado novamente',
          environment: this.environment,
          clock: (d) => this.clock(d),
        }),
      );
      return;
    }

    if (e.previous?.status === 'crashed') {
      this.logger.warn(`${INCIDENT_LOG} restarted after crash previousError="${e.previous.crashError ?? 'n/d'}"`);
      this.send({
        phase: 'restart',
        headline: 'RESTARTED',
        summary: 'Worker reiniciado com sucesso após um crash.',
        severity: 'info',
        fields: [
          ['Iniciado', this.clock(startedAt)],
          ['Status anterior', 'CRASHED'],
          ['Status atual', 'ONLINE'],
          ['Erro anterior', e.previous.crashError ?? 'n/d'],
          ...(missed !== null ? ([['Avaliações perdidas', String(missed)]] as Array<[string, string]>) : []),
          ['Ambiente', this.environment],
        ],
        incidentKey: 'WORKER_RESTART',
        at: startedAt.toISOString(),
      });
      return;
    }

    this.logger.log(
      `${INCIDENT_LOG} worker_start no_incident previousStatus=${e.previous?.status ?? 'none'} previousStop=${e.previous?.stopReason ?? 'none'}`,
    );
  }

  // ---------------------------------------------------------------------------------------------

  private async openWorkerOffline(data: Parameters<WorkerOfflineIncidentStore['open']>[0]): Promise<boolean> {
    if (!this.workerOffline) return true;
    try {
      return await this.workerOffline.open(data);
    } catch (err) {
      // Mongo unreachable (maybe the reason the loop stalled): alert anyway; the heartbeat service
      // only emits worker.stalled once per stall, so this can't repeat every minute.
      this.logger.warn(`${INCIDENT_LOG} could not persist WORKER_OFFLINE: ${(err as Error).message}`);
      return true;
    }
  }

  private cooldownAllows(key: string, now: Date): boolean {
    const last = this.lastNotifiedAt.get(key);
    return last === undefined || now.getTime() - last >= this.config.alertCooldownSeconds * 1000;
  }

  private send(notice: OpsNotice): void {
    void this.notifications.dispatch({ kind: 'ops', notice });
  }

  private clock(d: Date | string): string {
    return formatClock(d, this.config.timeZone);
  }

  private get environment(): string {
    return `${this.config.environment} · ${this.trading.mode}`;
  }
}

interface NoticeCtx {
  environment: string;
  clock: (d: Date) => string;
}

/** Shared with the heartbeat watchdog cron, so both senders produce the same message. */
export function workerOfflineNotice(
  a: NoticeCtx & { lastHeartbeatAt: Date | null; lastEvaluationAt: Date | null; lastStatus: string; now: Date },
): OpsNotice {
  return {
    phase: 'incident',
    headline: 'WORKER OFFLINE',
    summary: 'O Krypto worker parou de registrar heartbeat: nenhum candle está sendo avaliado.',
    severity: 'critical',
    fields: [
      ['Status', 'OFFLINE'],
      ['Último heartbeat', a.lastHeartbeatAt ? a.clock(a.lastHeartbeatAt) : 'nunca'],
      ['Última avaliação', a.lastEvaluationAt ? a.clock(a.lastEvaluationAt) : 'n/d'],
      ['Tempo sem heartbeat', a.lastHeartbeatAt ? formatSpan(a.now.getTime() - a.lastHeartbeatAt.getTime()) : 'n/d'],
      ['Último estado', a.lastStatus],
      ['Ambiente', a.environment],
    ],
    incidentKey: 'WORKER_OFFLINE',
    at: a.now.toISOString(),
  };
}

export function workerRecoveredNotice(
  a: NoticeCtx & { from: Date; to: Date; lastEvaluationAt: Date | null; missedCandles: number | null; how: string },
): OpsNotice {
  return {
    phase: 'recovery',
    headline: 'WORKER RECOVERED',
    summary: `Worker ONLINE novamente: ${a.how}.`,
    severity: 'info',
    fields: [
      ['Worker', 'ONLINE'],
      ['Último heartbeat antes da queda', a.clock(a.from)],
      ['Recuperado', a.clock(a.to)],
      ['Tempo indisponível', formatSpan(a.to.getTime() - a.from.getTime())],
      ['Última avaliação antes da queda', a.lastEvaluationAt ? a.clock(a.lastEvaluationAt) : 'n/d'],
      ...(a.missedCandles !== null
        ? ([
            [
              'Avaliações perdidas',
              a.missedCandles === 0
                ? '0'
                : `${a.missedCandles} candle(s) fechados sem avaliação em tempo real (não reprocessados para entrada; stop/alvo de posições PAPER conferidos)`,
            ],
          ] as Array<[string, string]>)
        : []),
      ['Ambiente', a.environment],
    ],
    incidentKey: 'WORKER_OFFLINE',
    at: a.to.toISOString(),
  };
}
