import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { notificationsConfig, tradingConfig } from '../../config/configuration';
import { ControlService } from '../../control/control.service';
import { WorkerHeartbeatService } from '../../control/worker-heartbeat.service';
import { BotEvent, BotEventDocument } from '../../events/schemas/bot-event.schema';
import { formatClock } from '../../incidents/incident-format.util';
import { IncidentService } from '../../incidents/incident.service';
import { EquitySnapshot, EquitySnapshotDocument } from '../../reports/schemas/equity-snapshot.schema';
import { SignalDocument, SignalRecord } from '../../risk/schemas/signal.schema';
import { Trade, TradeDocument } from '../../trades/schemas/trade.schema';
import { NotificationsService } from '../notifications.service';
import { dailyReportNotice, type DailyReportData } from '../report-notices';
import { DailyReportRun, DailyReportRunDocument } from './schemas/daily-report-run.schema';

const CHECK_INTERVAL_MS = 60_000;
const WINDOW_MS = 24 * 3_600_000;
const DUPLICATE_KEY = 11000;

/** Local calendar day and hour of `date` in `timeZone`. */
export function localDayAndHour(date: Date, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) };
}

/**
 * Once a day, at DAILY_REPORT_HOUR (NOTIFICATIONS_TIME_ZONE), sends a summary of the last 24h:
 * realized PnL, trades, equity, open positions, evaluations, signals and worker state. It doubles
 * as the daily "I'm alive" heartbeat — no message on a given morning means something is wrong.
 * If the process was down at that hour, the report goes out as soon as it comes back the same day.
 * Observability only: it reads collections, never touches trading state.
 */
@Injectable()
export class DailyReportService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailyReportService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** Local day already claimed by this process (saves a Mongo round trip per minute). */
  private doneDay?: string;
  private running = false;

  constructor(
    private readonly notifications: NotificationsService,
    private readonly control: ControlService,
    private readonly workerHeartbeat: WorkerHeartbeatService,
    private readonly incidents: IncidentService,
    @InjectModel(DailyReportRun.name) private readonly runModel: Model<DailyReportRunDocument>,
    @InjectModel(Trade.name) private readonly tradeModel: Model<TradeDocument>,
    @InjectModel(EquitySnapshot.name) private readonly equityModel: Model<EquitySnapshotDocument>,
    @InjectModel(BotEvent.name) private readonly eventModel: Model<BotEventDocument>,
    @InjectModel(SignalRecord.name) private readonly signalModel: Model<SignalDocument>,
    @Inject(notificationsConfig.KEY) private readonly config: ReturnType<typeof notificationsConfig>,
    @Inject(tradingConfig.KEY) private readonly trading: ReturnType<typeof tradingConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.config.dailyReportEnabled) return;
    this.logger.log(`Daily report at ${String(this.config.dailyReportHour).padStart(2, '0')}h (${this.config.timeZone})`);
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sends today's report when its hour has come and nobody sent it yet. Never throws. */
  async tick(now = new Date()): Promise<boolean> {
    const { day, hour } = localDayAndHour(now, this.config.timeZone);
    if (hour < this.config.dailyReportHour || this.doneDay === day || this.running) return false;
    this.running = true;
    try {
      if (!(await this.claim(day, now))) {
        this.doneDay = day;
        return false;
      }
      try {
        const data = await this.collect(now);
        await this.notifications.dispatch({ kind: 'report', report: dailyReportNotice(data, (d) => this.clock(d)) });
        this.doneDay = day;
        return true;
      } catch (err) {
        // Release the claim so the next tick retries instead of skipping the day.
        await this.runModel.deleteOne({ _id: day }).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      this.logger.warn(`Daily report failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.running = false;
    }
  }

  /** False when this day's report was already sent (by this or another process). */
  private async claim(day: string, now: Date): Promise<boolean> {
    try {
      await this.runModel.create({ _id: day, sentAt: now });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) return false;
      throw err;
    }
  }

  async collect(now: Date): Promise<DailyReportData> {
    const mode = this.trading.mode;
    const from = new Date(now.getTime() - WINDOW_MS);
    const live = { mode, runId: { $exists: false } };

    const [closed, open, equityNow, equityStart, evaluations, signals, state, worker] = await Promise.all([
      this.tradeModel
        .find({ mode, status: 'CLOSED', exitTime: { $gte: from, $lte: now }, isSeed: { $ne: true } })
        .select({ pnl: 1, pnlPct: 1, fees: 1 })
        .lean(),
      this.tradeModel.find({ mode, status: 'OPEN' }).select({ symbol: 1, side: 1 }).lean(),
      this.equityModel.findOne(live).sort({ timestamp: -1 }).lean(),
      this.equityModel.findOne({ ...live, timestamp: { $gte: from } }).sort({ timestamp: 1 }).lean(),
      this.eventModel.countDocuments({ type: 'bot.cycle', at: { $gte: from }, 'data.reevaluation': { $ne: true } }),
      this.signalModel.aggregate<{ _id: boolean; n: number }>([
        { $match: { mode, candleTime: { $gte: from } } },
        { $group: { _id: '$approved', n: { $sum: 1 } } },
      ]),
      this.control.getState(),
      this.workerHeartbeat.getStatus(now),
    ]);

    return {
      mode,
      from,
      to: now,
      closedTrades: closed.map((t) => ({ pnl: t.pnl ?? 0, pnlPct: t.pnlPct ?? 0 })),
      totalFees: closed.reduce((sum, t) => sum + (t.fees ?? 0), 0),
      openPositions: open.map((t) => ({ symbol: t.symbol, side: t.side })),
      equityNow: equityNow?.equity ?? null,
      equityStart: equityStart?.equity ?? null,
      evaluations,
      signalsApproved: signals.find((s) => s._id === true)?.n ?? 0,
      signalsVetoed: signals.find((s) => s._id === false)?.n ?? 0,
      activeIncidents: this.incidents.getActive().map((i) => i.key),
      paused: state.isPaused,
      pauseReason: state.pauseReason,
      workerState: worker.state,
      lastEvaluationAt: worker.lastEvaluationAt,
    };
  }

  private clock(d: Date): string {
    return formatClock(d, this.config.timeZone);
  }
}
