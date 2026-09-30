import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

const ERROR_REEMIT_MS = 10 * 60_000;

export interface SignalSnapshot {
  action: string;
  reason: string;
  at: Date;
  /** Close time of the evaluated candle (ISO); absent when the strategy couldn't evaluate. */
  candleTime?: string;
  /** Close price of that candle. */
  price?: number;
  /** The strategy's own indicator snapshot (emaFast, emaSlow, rsi, atr, emaRegime). */
  indicators?: Record<string, number | undefined>;
}

export interface CycleDetails {
  /** Epoch ms of the evaluated candle's close. */
  candleTime?: number;
  price?: number;
  indicators?: Record<string, number | undefined>;
}

/**
 * In-memory observability state for GET /bot/status and the periodic heartbeat log.
 * Never persisted and never consulted for trading decisions - purely "what is the bot doing
 * right now", so a restart losing this history is fine (bot_state/trades remain the source
 * of truth for anything that matters to risk/execution).
 */
@Injectable()
export class RuntimeStatusService {
  private lastCycleAt?: Date;
  private readonly lastSignalBySymbol = new Map<string, SignalSnapshot>();
  private lastError?: string;
  private lastErrorEmittedAt = 0;
  private lastPollAt?: Date;

  /** Optional so the service stays constructible without DI in tests. */
  constructor(@Optional() private readonly eventEmitter?: EventEmitter2) {}

  /**
   * Heartbeat of the polling loop, recorded after every tick. Unlike lastCycleAt (which only moves
   * when a new candle closes, i.e. hourly on 1h), this tells a dashboard whether the loop is alive.
   */
  recordPoll(): void {
    this.lastPollAt = new Date();
  }

  getLastPollAt(): Date | null {
    return this.lastPollAt ?? null;
  }

  /**
   * Called once per new closed candle and symbol (hourly on 1h). Also emitted as `bot.cycle`, so
   * HOLD/EXIT decisions — which the signals collection doesn't store — reach the event history.
   */
  recordCycle(symbol: string, action: string, reason: string, details: CycleDetails = {}): void {
    const at = new Date();
    this.lastCycleAt = at;
    const extra = {
      ...(details.candleTime !== undefined ? { candleTime: new Date(details.candleTime).toISOString() } : {}),
      ...(details.price !== undefined ? { price: details.price } : {}),
      ...(details.indicators ? { indicators: details.indicators } : {}),
    };
    this.lastSignalBySymbol.set(symbol, { action, reason, at, ...extra });
    this.eventEmitter?.emit('bot.cycle', { symbol, action, reason, at: at.toISOString(), ...extra });
  }

  /**
   * Also emits `bot.error` for the dashboard's live feed — only when the message changes or 10 min
   * after the last emit, so a loop failing every tick doesn't flood the stream.
   */
  recordError(message: string): void {
    const now = Date.now();
    if (message !== this.lastError || now - this.lastErrorEmittedAt >= ERROR_REEMIT_MS) {
      this.lastErrorEmittedAt = now;
      this.eventEmitter?.emit('bot.error', { message, at: new Date(now).toISOString() });
    }
    this.lastError = message;
  }

  getLastCycleAt(): Date | null {
    return this.lastCycleAt ?? null;
  }

  getLastSignalBySymbol(): Record<string, SignalSnapshot> {
    return Object.fromEntries(this.lastSignalBySymbol);
  }

  getLastError(): string | null {
    return this.lastError ?? null;
  }

  /** Human-friendly "12s ago"/"5m ago" label for the heartbeat log line. */
  getLastCycleAgoLabel(): string {
    if (!this.lastCycleAt) return 'never';
    const seconds = Math.round((Date.now() - this.lastCycleAt.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    return `${Math.round(seconds / 60)}m ago`;
  }
}
