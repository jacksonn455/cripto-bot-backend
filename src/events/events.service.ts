import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { MessageEvent } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { interval, map, merge, Observable, Subject } from 'rxjs';
import { tradingConfig } from '../config/configuration';
import { BotEvent, BotEventDocument } from './schemas/bot-event.schema';

/** Keeps idle SSE connections alive through proxies (Node fetch drops a body silent for 5 min). */
const HEARTBEAT_MS = 25_000;

export interface StoredEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

/**
 * Bridges internal domain events (emitted by execution/reconciliation/control/backtest) to an SSE
 * stream for the dashboard, and keeps a 30-day history of them (GET /events/recent). Every
 * message carries an `id` (the history document id) so clients can merge history and live
 * events without duplicates.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private readonly subject = new Subject<MessageEvent>();

  constructor(
    @InjectModel(BotEvent.name) private readonly eventModel: Model<BotEventDocument>,
    @Inject(tradingConfig.KEY) private readonly trading: ReturnType<typeof tradingConfig>,
  ) {}

  /** Per subscriber: domain events plus a `ping` heartbeat that clients can ignore. */
  asObservable(): Observable<MessageEvent> {
    const heartbeat = interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: '{}' })));
    return merge(this.subject.asObservable(), heartbeat);
  }

  /** Newest first. `before` (an event id) pages further back. */
  async recent(limit: number, before?: string): Promise<StoredEvent[]> {
    const filter = before && Types.ObjectId.isValid(before) ? { _id: { $lt: new Types.ObjectId(before) } } : {};
    const docs = await this.eventModel.find(filter).sort({ _id: -1 }).limit(limit).lean();
    return docs.map((d) => ({ id: String(d._id), type: d.type, data: d.data, at: d.at.toISOString() }));
  }

  @OnEvent('trade.opened')
  onTradeOpened(payload: unknown): void {
    this.push('trade.opened', payload);
  }

  @OnEvent('trade.closed')
  onTradeClosed(payload: unknown): void {
    this.push('trade.closed', payload);
  }

  @OnEvent('bot.paused')
  onBotPaused(payload: unknown): void {
    this.push('bot.paused', payload);
  }

  @OnEvent('bot.resumed')
  onBotResumed(payload: unknown): void {
    this.push('bot.resumed', payload);
  }

  @OnEvent('alert.critical')
  onAlert(payload: unknown): void {
    this.push('alert.critical', payload);
  }

  /** Entry signal evaluated by risk — approved or vetoed (with rejectReason). */
  @OnEvent('signal.recorded')
  onSignal(payload: unknown): void {
    this.push('signal.recorded', payload);
  }

  @OnEvent('backtest.completed')
  onBacktest(payload: unknown): void {
    this.push('backtest.completed', payload);
  }

  /** New closed candle evaluated: HOLD / ENTER / EXIT / SKIP decision per symbol. */
  /**
   * After a restart the loop re-evaluates the last closed candle (its "already processed" marker
   * lives in memory). Those repeats are flagged `reevaluation: true` — still streamed and stored,
   * so nothing is hidden from the history, but the dashboard can fold them away.
   */
  @OnEvent('bot.cycle')
  async onCycle(payload: unknown): Promise<void> {
    const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    let reevaluation = false;
    if (typeof data.symbol === 'string' && typeof data.candleTime === 'string') {
      reevaluation = await this.eventModel
        .exists({ type: 'bot.cycle', 'data.symbol': data.symbol, 'data.candleTime': data.candleTime })
        .then((found) => found !== null)
        .catch(() => false);
    }
    this.push('bot.cycle', { ...data, reevaluation }, { withMode: true });
  }

  /** Execution loop error (deduplicated at the source, see RuntimeStatusService). */
  @OnEvent('bot.error')
  onError(payload: unknown): void {
    this.push('bot.error', payload, { withMode: true });
  }

  private push(type: string, payload: unknown, opts: { withMode?: boolean } = {}): void {
    const base = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    // Emitters of bot-level events don't know the trading mode; the dashboard labels every event with one.
    const data = opts.withMode && base.mode === undefined ? { ...base, mode: this.trading.mode } : base;
    const id = new Types.ObjectId();
    this.subject.next({ id: id.toHexString(), type, data: JSON.stringify(data) });
    // History is best-effort: a failed insert must never break the live stream.
    this.eventModel.create({ _id: id, type, data, at: new Date() }).catch((err: Error) => {
      this.logger.warn(`Could not store ${type} event: ${err.message}`);
    });
  }
}
