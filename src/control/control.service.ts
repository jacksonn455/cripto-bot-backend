import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { executionConfig, tradingConfig } from '../config/configuration';
import { EXCHANGE_GATEWAY } from '../exchange/exchange-gateway.interface';
import type { ExchangeGateway } from '../exchange/exchange-gateway.interface';
import { generateClientOrderId } from '../execution/client-order-id.util';
import { exitOrderSide } from '../trades/position-math.util';
import { TRADE_CLOSED } from '../trades/trade-events';
import { TradesService } from '../trades/trades.service';
import { EVALUATION_SNAPSHOT_STORE, InMemoryEvaluationSnapshotStore } from './evaluation-snapshot.store';
import type { EvaluationSnapshot, EvaluationSnapshotStore } from './evaluation-snapshot.store';
import { RuntimeStatusService, SignalSnapshot } from './runtime-status.service';
import { BotState, BotStateDocument } from './schemas/bot-state.schema';
import { PauseEpisode, PauseEpisodeDocument } from './schemas/pause-episode.schema';
import { formatDuration } from './duration.util';
import { WorkerHeartbeatService, WorkerStatus } from './worker-heartbeat.service';

const QUOTE_ASSET = 'USDT'; // v1: all configured pairs are USDT-quoted (BTCUSDT, ETHUSDT).

export interface KillSwitchResult {
  canceledOrders: number;
  closedPositions: number;
}

export interface AutoPauseThresholds {
  dailyPnl: number;
  accountEquity: number;
  maxDailyLossPct: number;
  consecutiveStopLosses: number;
  maxConsecutiveStops: number;
}

export interface BotStatus {
  mode: string;
  paused: boolean;
  pauseReason?: string;
  /** While paused: when the pause started and how long it has lasted (until POST /bot/resume). */
  pausedAt?: Date;
  pausedForMs?: number;
  lastReconciliationAt?: Date;
  lastReconciliationOk: boolean;
  /** Last time a new closed candle was evaluated (moves once per strategy timeframe). */
  lastCycleAt: Date | null;
  /** Last completed tick of the polling loop (moves every pollIntervalSeconds while alive). */
  lastPollAt: Date | null;
  executionEnabled: boolean;
  pollIntervalSeconds: number;
  /** Latest persisted evaluation per symbol (survives restarts; see evaluation_snapshots). */
  lastSignalBySymbol: Record<string, SignalSnapshot>;
  /** Symbols whose last market-data fetch failed, until a fetch succeeds again. */
  symbolErrors: Record<string, { message: string; at: Date }>;
  openTrades: number;
  equity: number;
  lastError: string | null;
  /**
   * Execution worker liveness from its persisted heartbeat (ONLINE/OFFLINE/STARTING/DISABLED).
   * Independent of trades and of lastCycleAt: "no entry" never means "worker offline".
   */
  worker: WorkerStatus;
}

@Injectable()
export class ControlService {
  private readonly logger = new Logger(ControlService.name);

  constructor(
    @InjectModel(BotState.name) private readonly stateModel: Model<BotStateDocument>,
    @Inject(EXCHANGE_GATEWAY) private readonly gateway: ExchangeGateway,
    private readonly tradesService: TradesService,
    private readonly runtimeStatus: RuntimeStatusService,
    private readonly workerHeartbeat: WorkerHeartbeatService,
    @Inject(tradingConfig.KEY) private readonly trading: ReturnType<typeof tradingConfig>,
    private readonly eventEmitter: EventEmitter2,
    @Inject(executionConfig.KEY) private readonly execution: ReturnType<typeof executionConfig>,
    @Optional()
    @Inject(EVALUATION_SNAPSHOT_STORE)
    private readonly snapshots: EvaluationSnapshotStore = new InMemoryEvaluationSnapshotStore(),
    @Optional()
    @InjectModel(PauseEpisode.name)
    private readonly pauseEpisodes?: Model<PauseEpisodeDocument>,
  ) {}

  async getState(): Promise<BotState> {
    return this.getOrCreateState();
  }

  /** Everything GET /bot/status needs: persisted bot_state + live execution/runtime info. */
  async getStatus(): Promise<BotStatus> {
    const mode = this.trading.mode;
    const [state, openTrades, balance, worker, stored] = await Promise.all([
      this.getOrCreateState(),
      this.tradesService.countOpenPositions(mode),
      this.gateway.getBalance(QUOTE_ASSET).catch(() => null),
      this.workerHeartbeat.getStatus(),
      this.snapshots.list(mode).catch((err: Error) => {
        this.logger.warn(`Could not read evaluation snapshots: ${err.message}`);
        return [];
      }),
    ]);

    const lastSignalBySymbol: Record<string, SignalSnapshot> = {};
    const symbolErrors: BotStatus['symbolErrors'] = {};
    let lastEvaluationAt: Date | null = null;
    let lastCycleAt: Date | null = null;
    for (const s of stored) {
      if (s.lastError && s.lastErrorAt) symbolErrors[s.symbol] = { message: s.lastError, at: s.lastErrorAt };
      if (!s.snapshot) continue;
      lastSignalBySymbol[s.symbol] = toSignalSnapshot(s.snapshot);
      const at = s.snapshot.evaluatedAt;
      if (!lastEvaluationAt || at > lastEvaluationAt) lastEvaluationAt = at;
      if (s.snapshot.source === 'cycle' && (!lastCycleAt || at > lastCycleAt)) lastCycleAt = at;
    }
    const runtimeCycleAt = this.runtimeStatus.getLastCycleAt();
    if (runtimeCycleAt && (!lastCycleAt || runtimeCycleAt > lastCycleAt)) lastCycleAt = runtimeCycleAt;

    return {
      mode,
      paused: state.isPaused,
      // Only meaningful while paused (docs from before the resume fix may carry a stale reason).
      pauseReason: state.isPaused ? state.pauseReason : undefined,
      ...(state.isPaused && state.pausedAt
        ? { pausedAt: state.pausedAt, pausedForMs: Date.now() - new Date(state.pausedAt).getTime() }
        : {}),
      lastReconciliationAt: state.lastReconciliationAt,
      lastReconciliationOk: state.lastReconciliationOk,
      lastCycleAt,
      lastPollAt: this.runtimeStatus.getLastPollAt(),
      executionEnabled: this.execution.enabled,
      pollIntervalSeconds: this.execution.pollIntervalSeconds,
      lastSignalBySymbol,
      symbolErrors,
      openTrades,
      equity: balance?.free ?? 0,
      lastError: this.runtimeStatus.getLastError(),
      // Same source as lastSignalBySymbol, so the worker card and the per-symbol panel always agree.
      worker: lastEvaluationAt ? { ...worker, lastEvaluationAt } : worker,
    };
  }

  async isPaused(): Promise<boolean> {
    const state = await this.getOrCreateState();
    return state.isPaused;
  }

  async pause(reason: string): Promise<void> {
    const state = await this.getOrCreateState();
    const now = new Date();
    const alreadyPaused = state.isPaused;
    // A pause while paused keeps the original start: the episode lasts until the next resume.
    const pausedAt = alreadyPaused && state.pausedAt ? state.pausedAt : now;
    await this.stateModel.updateOne(
      {},
      { $set: { isPaused: true, pauseReason: reason, pausedAt, updatedAt: now } },
      { upsert: true },
    );
    await this.recordPauseEpisode(alreadyPaused, reason, now);
    this.logger.warn(
      `Bot paused: ${reason}` +
        (alreadyPaused ? ` (already paused since ${new Date(pausedAt).toISOString()})` : ` at ${now.toISOString()}`) +
        ' - new entries blocked until POST /bot/resume',
    );
    this.eventEmitter.emit('bot.paused', { reason, pausedAt: new Date(pausedAt).toISOString() });
  }

  async resume(): Promise<void> {
    const state = await this.getOrCreateState();
    const now = new Date();
    await this.stateModel.updateOne(
      {},
      // $set with undefined is dropped by Mongoose, so the old reason must be removed explicitly.
      // A resume also starts the consecutive-stop streak over (see BotState.stopStreakResetAt).
      { $set: { isPaused: false, stopStreakResetAt: now, updatedAt: now }, $unset: { pauseReason: 1, pausedAt: 1 } },
      { upsert: true },
    );
    const pausedForMs = state.isPaused && state.pausedAt ? now.getTime() - new Date(state.pausedAt).getTime() : undefined;
    if (state.isPaused) await this.closePauseEpisode(now, pausedForMs);
    this.logger.log(
      state.isPaused
        ? `Bot resumed after ${pausedForMs !== undefined ? formatDuration(pausedForMs) : 'an unknown time'} ` +
            `(pause reason: ${state.pauseReason ?? 'unknown'})`
        : 'Bot resumed (was not paused)',
    );
    this.eventEmitter.emit(
      'bot.resumed',
      state.isPaused
        ? {
            pauseReason: state.pauseReason ?? null,
            pausedAt: state.pausedAt ? new Date(state.pausedAt).toISOString() : null,
            pausedForMs: pausedForMs ?? null,
          }
        : {},
    );
  }

  /** Newest first. */
  async listPauseEpisodes(limit = 20): Promise<PauseEpisode[]> {
    if (!this.pauseEpisodes) return [];
    return this.pauseEpisodes.find({}).sort({ pausedAt: -1 }).limit(limit).lean();
  }

  /** Observability only: a failed write is logged, the pause itself already happened. */
  private async recordPauseEpisode(alreadyPaused: boolean, reason: string, at: Date): Promise<void> {
    if (!this.pauseEpisodes) return;
    try {
      const open = alreadyPaused
        ? await this.pauseEpisodes.findOne({ resumedAt: { $exists: false } }).sort({ pausedAt: -1 })
        : null;
      if (open) {
        await this.pauseEpisodes.updateOne({ _id: open._id }, { $push: { additionalReasons: { reason, at } } });
      } else {
        await this.pauseEpisodes.create({ pausedAt: at, reason, mode: this.trading.mode, additionalReasons: [] });
      }
    } catch (err) {
      this.logger.warn(`Could not record the pause episode: ${(err as Error).message}`);
    }
  }

  private async closePauseEpisode(at: Date, durationMs: number | undefined): Promise<void> {
    if (!this.pauseEpisodes) return;
    try {
      const open = await this.pauseEpisodes.findOne({ resumedAt: { $exists: false } }).sort({ pausedAt: -1 });
      if (open) {
        await this.pauseEpisodes.updateOne(
          { _id: open._id },
          { $set: { resumedAt: at, durationMs: durationMs ?? at.getTime() - new Date(open.pausedAt).getTime() } },
        );
      }
    } catch (err) {
      this.logger.warn(`Could not close the pause episode: ${(err as Error).message}`);
    }
  }

  async recordReconciliation(ok: boolean): Promise<void> {
    await this.stateModel.updateOne(
      {},
      { $set: { lastReconciliationAt: new Date(), lastReconciliationOk: ok } },
      { upsert: true },
    );
  }

  /** Pauses the bot automatically if the daily loss limit or consecutive-stops limit is hit. */
  async checkAutoPauseConditions(ctx: AutoPauseThresholds): Promise<void> {
    if (ctx.dailyPnl <= -ctx.maxDailyLossPct * ctx.accountEquity) {
      await this.pause('DAILY_LOSS_LIMIT');
      return;
    }
    if (ctx.consecutiveStopLosses >= ctx.maxConsecutiveStops) {
      await this.pause('CONSECUTIVE_STOPS_LIMIT');
    }
  }

  /** Cancels all open orders, closes all open positions at market, then pauses the bot. */
  async killSwitch(): Promise<KillSwitchResult> {
    const mode = this.trading.mode;
    let canceledOrders = 0;
    let closedPositions = 0;

    const openOrders = await this.gateway.getOpenOrders();
    for (const order of openOrders) {
      try {
        await this.gateway.cancelOrder(order.symbol, order.clientOrderId);
        canceledOrders += 1;
      } catch (err) {
        this.logger.error(`Kill switch: failed to cancel order ${order.clientOrderId}: ${(err as Error).message}`);
      }
    }

    const openTrades = await this.tradesService.findAllOpen(mode);
    for (const trade of openTrades) {
      try {
        const clientOrderId = generateClientOrderId(mode, trade.symbol, Date.now(), 'EXIT');
        const order = await this.gateway.placeOrder({
          symbol: trade.symbol,
          side: exitOrderSide(trade.side),
          type: 'MARKET',
          quantity: trade.qty,
          newClientOrderId: clientOrderId,
        });
        const closed = await this.tradesService.settlePosition(trade, {
          exitPrice: order.price || trade.entryPrice,
          exitTime: new Date(),
          exitReason: 'KILL_SWITCH',
        });
        this.eventEmitter.emit(TRADE_CLOSED, closed);
        closedPositions += 1;
      } catch (err) {
        this.logger.error(`Kill switch: failed to close ${trade.symbol}: ${(err as Error).message}`);
      }
    }

    await this.pause('KILL_SWITCH');
    this.eventEmitter.emit('alert.critical', {
      message: `Kill switch triggered: ${canceledOrders} order(s) canceled, ${closedPositions} position(s) closed`,
    });

    return { canceledOrders, closedPositions };
  }

  private async getOrCreateState(): Promise<BotStateDocument> {
    const existing = await this.stateModel.findOne({});
    if (existing) return existing;
    return this.stateModel.create({ isPaused: false, lastReconciliationOk: true, updatedAt: new Date() });
  }
}

function toSignalSnapshot(s: EvaluationSnapshot): SignalSnapshot {
  return {
    action: s.action,
    reason: s.reason,
    at: s.evaluatedAt,
    candleTime: new Date(s.candleCloseTime).toISOString(),
    candleOpenTime: new Date(s.candleOpenTime).toISOString(),
    ...(s.price !== undefined ? { price: s.price } : {}),
    indicators: s.indicators,
    source: s.source,
    ...(s.side ? { side: s.side } : {}),
    ...(s.conditions ? { conditions: s.conditions } : {}),
    decision: s.decision,
  };
}
