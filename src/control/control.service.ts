import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { RuntimeStatusService, SignalSnapshot } from './runtime-status.service';
import { BotState, BotStateDocument } from './schemas/bot-state.schema';
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
  lastReconciliationAt?: Date;
  lastReconciliationOk: boolean;
  /** Last time a new closed candle was evaluated (moves once per strategy timeframe). */
  lastCycleAt: Date | null;
  /** Last completed tick of the polling loop (moves every pollIntervalSeconds while alive). */
  lastPollAt: Date | null;
  executionEnabled: boolean;
  pollIntervalSeconds: number;
  lastSignalBySymbol: Record<string, SignalSnapshot>;
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
  ) {}

  async getState(): Promise<BotState> {
    return this.getOrCreateState();
  }

  /** Everything GET /bot/status needs: persisted bot_state + live execution/runtime info. */
  async getStatus(): Promise<BotStatus> {
    const mode = this.trading.mode;
    const [state, openTrades, balance, worker] = await Promise.all([
      this.getOrCreateState(),
      this.tradesService.countOpenPositions(mode),
      this.gateway.getBalance(QUOTE_ASSET).catch(() => null),
      this.workerHeartbeat.getStatus(),
    ]);

    return {
      mode,
      paused: state.isPaused,
      // Only meaningful while paused (docs from before the resume fix may carry a stale reason).
      pauseReason: state.isPaused ? state.pauseReason : undefined,
      lastReconciliationAt: state.lastReconciliationAt,
      lastReconciliationOk: state.lastReconciliationOk,
      lastCycleAt: this.runtimeStatus.getLastCycleAt(),
      lastPollAt: this.runtimeStatus.getLastPollAt(),
      executionEnabled: this.execution.enabled,
      pollIntervalSeconds: this.execution.pollIntervalSeconds,
      lastSignalBySymbol: this.runtimeStatus.getLastSignalBySymbol(),
      openTrades,
      equity: balance?.free ?? 0,
      lastError: this.runtimeStatus.getLastError(),
      worker,
    };
  }

  async isPaused(): Promise<boolean> {
    const state = await this.getOrCreateState();
    return state.isPaused;
  }

  async pause(reason: string): Promise<void> {
    await this.stateModel.updateOne(
      {},
      { $set: { isPaused: true, pauseReason: reason, updatedAt: new Date() } },
      { upsert: true },
    );
    this.logger.warn(`Bot paused: ${reason}`);
    this.eventEmitter.emit('bot.paused', { reason });
  }

  async resume(): Promise<void> {
    const now = new Date();
    await this.stateModel.updateOne(
      {},
      // $set with undefined is dropped by Mongoose, so the old reason must be removed explicitly.
      // A resume also starts the consecutive-stop streak over (see BotState.stopStreakResetAt).
      { $set: { isPaused: false, stopStreakResetAt: now, updatedAt: now }, $unset: { pauseReason: 1 } },
      { upsert: true },
    );
    this.logger.log('Bot resumed');
    this.eventEmitter.emit('bot.resumed', {});
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
