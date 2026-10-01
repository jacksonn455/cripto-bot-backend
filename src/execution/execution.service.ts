import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { executionConfig, riskConfig, tradingConfig, trendRegimeConfig } from '../config/configuration';
import { ControlService } from '../control/control.service';
import { RuntimeStatusService } from '../control/runtime-status.service';
import { WORKER_INSTANCE_ID, WORKER_LOG } from '../control/worker-heartbeat.service';
import { EXCHANGE_GATEWAY } from '../exchange/exchange-gateway.interface';
import type { ExchangeGateway } from '../exchange/exchange-gateway.interface';
import { Candle } from '../exchange/types/candle.type';
import { checkIntraCandleExit } from '../backtest/intra-candle-exit.util';
import { RiskContextBuilderService } from '../risk/risk-context-builder.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { SignalsService } from '../risk/signals.service';
import { StrategyRegistryService } from '../strategy/strategy-registry.service';
import type { Signal, StrategyContext } from '../strategy/strategy.interface';
import { OrdersService } from '../trades/orders.service';
import { entryOrderSide, exitOrderSide, sideFromSignal } from '../trades/position-math.util';
import type { TradeDocument, TradeExitReason, TradeMode, TradeSide } from '../trades/schemas/trade.schema';
import { buildTradeOpenedEvent, TRADE_CLOSED, TRADE_OPENED, TradeClosedEvent } from '../trades/trade-events';
import { TradesService } from '../trades/trades.service';
import { generateClientOrderId } from './client-order-id.util';
import { EVALUATION_CHECKPOINT_STORE } from './evaluation-checkpoint.store';
import type { EvaluationCheckpointStore } from './evaluation-checkpoint.store';
import { ReconciliationService } from './reconciliation.service';

const QUOTE_ASSET = 'USDT'; // v1: all configured pairs are USDT-quoted (BTCUSDT, ETHUSDT).

/** Fetching candles from the exchange failed (Binance down, timeout, 451, rate limit...). */
export class MarketDataError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MarketDataError';
  }
}

export type CycleOutcome =
  | { status: 'no-candles' }
  /** Already evaluated (in this process, before a restart, or by an overlapping process right now). */
  | { status: 'already-evaluated'; candleCloseTime: number }
  /** A newly closed candle was evaluated; missedCandles = closed candles skipped while the worker was down. */
  | { status: 'evaluated'; candleCloseTime: number; missedCandles: number };

/**
 * SIGNAL → RISK → ENTRY → POSITION → EXIT → PNL → EVENT, identical for LONG and SHORT: the side
 * only decides which order opens/closes the position (BUY/SELL) and the sign of the pnl.
 */
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);
  /** Fast path only (saves a DB round trip per tick); the persisted checkpoint is the source of truth. */
  private readonly lastProcessedCloseTime = new Map<string, number>();
  /** Symbols whose current cycle already sent an order — such a cycle must not be retried. */
  private readonly ordersPlacedInCycle = new Set<string>();

  constructor(
    @Inject(EXCHANGE_GATEWAY) private readonly gateway: ExchangeGateway,
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly riskManager: RiskManagerService,
    private readonly riskContextBuilder: RiskContextBuilderService,
    private readonly signalsService: SignalsService,
    private readonly tradesService: TradesService,
    private readonly ordersService: OrdersService,
    private readonly reconciliation: ReconciliationService,
    private readonly controlService: ControlService,
    private readonly runtimeStatus: RuntimeStatusService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(tradingConfig.KEY) private readonly trading: ReturnType<typeof tradingConfig>,
    @Inject(trendRegimeConfig.KEY) private readonly strategyConfig: ReturnType<typeof trendRegimeConfig>,
    @Inject(executionConfig.KEY) private readonly config: ReturnType<typeof executionConfig>,
    @Inject(riskConfig.KEY) private readonly riskConfigValues: ReturnType<typeof riskConfig>,
    @Inject(EVALUATION_CHECKPOINT_STORE) private readonly checkpoints: EvaluationCheckpointStore,
  ) {}

  /**
   * Evaluates the latest closed candle of `symbol` exactly once. Called every poll tick; only does
   * work when a new candle has closed. The candle is claimed in evaluation_checkpoints first, so
   * a restart doesn't re-evaluate it and two overlapping processes can't both act on it.
   */
  async runCycle(symbol: string, strategyName: string): Promise<CycleOutcome> {
    const mode = this.trading.mode;
    const strategy = this.strategyRegistry.get(strategyName);

    const candles = await this.fetchClosedCandles(
      symbol,
      this.strategyConfig.timeframe,
      this.strategyConfig.emaRegime + 10,
    );
    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return { status: 'no-candles' };

    const dedupeKey = `${mode}:${symbol}`;
    if (this.lastProcessedCloseTime.get(dedupeKey) === lastCandle.closeTime) {
      return { status: 'already-evaluated', candleCloseTime: lastCandle.closeTime };
    }

    const checkpointKey = `${mode}:${symbol}:${this.strategyConfig.timeframe}`;
    const claim = await this.checkpoints.claim(checkpointKey, lastCandle.closeTime, WORKER_INSTANCE_ID);
    if (!claim.claimed) {
      // Committed before = done for good. Otherwise another live process holds it: ask again next tick.
      if (claim.previousCloseTime !== null && claim.previousCloseTime >= lastCandle.closeTime) {
        this.lastProcessedCloseTime.set(dedupeKey, lastCandle.closeTime);
      }
      return { status: 'already-evaluated', candleCloseTime: lastCandle.closeTime };
    }

    const previous = claim.previousCloseTime;
    const missed = previous === null ? [] : candles.filter((c) => c.closeTime > previous && c.closeTime < lastCandle.closeTime);
    this.logger.log(
      `${WORKER_LOG} evaluating symbol=${symbol} candleClose=${new Date(lastCandle.closeTime).toISOString()} ` +
        `missedCandles=${missed.length}`,
    );

    this.ordersPlacedInCycle.delete(symbol);
    try {
      await this.evaluateCandle(symbol, strategy, mode, candles, lastCandle, missed);
    } catch (err) {
      if (this.ordersPlacedInCycle.has(symbol)) {
        // An order already went out: retrying could send it twice. Mark the candle done instead.
        this.logger.error(
          `${WORKER_LOG} evaluation_failed_after_order symbol=${symbol} - candle not retried to avoid a duplicate order`,
        );
        this.lastProcessedCloseTime.set(dedupeKey, lastCandle.closeTime);
        await this.commitCheckpoint(checkpointKey, lastCandle.closeTime);
      } else {
        // Nothing was sent: free the candle so the next tick retries it.
        await this.checkpoints
          .release(checkpointKey, lastCandle.closeTime, WORKER_INSTANCE_ID)
          .catch((e: Error) => this.logger.warn(`Could not release the claim on ${checkpointKey}: ${e.message}`));
      }
      throw err;
    }

    this.lastProcessedCloseTime.set(dedupeKey, lastCandle.closeTime);
    await this.commitCheckpoint(checkpointKey, lastCandle.closeTime);
    return { status: 'evaluated', candleCloseTime: lastCandle.closeTime, missedCandles: missed.length };
  }

  private async commitCheckpoint(key: string, closeTime: number): Promise<void> {
    try {
      await this.checkpoints.commit(key, closeTime, WORKER_INSTANCE_ID);
    } catch (err) {
      // The claim's lease still keeps other processes off this candle for a while, and this
      // process remembers it in memory: only a restart within the lease could re-evaluate it.
      this.logger.error(`${WORKER_LOG} checkpoint_commit_failed key=${key} error="${(err as Error).message}"`);
    }
  }

  private async evaluateCandle(
    symbol: string,
    strategy: ReturnType<StrategyRegistryService['get']>,
    mode: TradeMode,
    candles: Candle[],
    lastCandle: Candle,
    missed: Candle[],
  ): Promise<void> {
    const regimeCandles =
      this.strategyConfig.regimeTimeframe === this.strategyConfig.timeframe
        ? undefined
        : await this.fetchClosedCandles(
            symbol,
            this.strategyConfig.regimeTimeframe,
            this.strategyConfig.emaRegime + 10,
          );

    let openTrade = await this.tradesService.findOpenPosition(symbol, mode);

    if (openTrade) {
      if (mode === 'PAPER') {
        // Candles missed while the worker was down are checked too (oldest first): a stop/target
        // they touched would have closed the position had the worker been running.
        const entryMs = openTrade.entryTime ? new Date(openTrade.entryTime).getTime() : 0;
        for (const c of [...missed.filter((m) => m.closeTime > entryMs), lastCandle]) {
          const intraExit = checkIntraCandleExit(
            { stopLoss: openTrade.stopLoss, takeProfit: openTrade.takeProfit, side: openTrade.side },
            c,
          );
          if (intraExit) {
            await this.closePaperPosition(openTrade, intraExit.exitPrice, c.closeTime, intraExit.reason);
            openTrade = null;
            break;
          }
        }
      }

      if (openTrade) {
        const signal = this.tryEvaluate(strategy.onCandleClosed.bind(strategy), symbol, candles, regimeCandles, {
          side: openTrade.side === 'SHORT' ? 'SHORT' : 'LONG',
          entryPrice: openTrade.entryPrice,
          stopLoss: openTrade.stopLoss,
        });
        this.logCycle(symbol, signal);
        if (signal?.action === 'EXIT') {
          await this.exitPosition(openTrade, signal.price, lastCandle.closeTime, 'SIGNAL', mode, symbol, signal.reason);
          openTrade = null;
        }
      }
    }

    if (!openTrade) {
      const signal = this.tryEvaluate(strategy.onCandleClosed.bind(strategy), symbol, candles, regimeCandles, null);
      this.logCycle(symbol, signal);
      if (signal && sideFromSignal(signal.action)) {
        await this.tryEnter(signal, symbol, mode, lastCandle);
      }
    }
  }

  /** Logs signal=HOLD/ENTER_LONG/ENTER_SHORT/EXIT/SKIP + reason every cycle, not just entries/exits. */
  private logCycle(symbol: string, signal: Signal | null): void {
    if (!signal) {
      const reason = 'strategy evaluation failed or not enough candle history yet';
      this.logger.log(`Cycle ${symbol}: signal=SKIP reason="${reason}"`);
      this.runtimeStatus.recordCycle(symbol, 'SKIP', reason);
      return;
    }
    const label = signal.action === 'NONE' ? 'HOLD' : signal.action;
    const ema200 = signal.indicators.emaRegime;
    this.logger.log(
      `Cycle ${symbol}: signal=${label} reason="${signal.reason}" close=${signal.price} ema200=${ema200 ?? 'n/a'}`,
    );
    // Observability only: the dashboard explains the decision with the numbers behind it.
    this.runtimeStatus.recordCycle(symbol, label, signal.reason, {
      candleTime: signal.candleTime,
      price: signal.price,
      indicators: signal.indicators,
    });
  }

  private async tryEnter(signal: Signal, symbol: string, mode: TradeMode, lastCandle: Candle): Promise<void> {
    const side = sideFromSignal(signal.action)!;
    const riskCtx = await this.riskContextBuilder.build(
      this.gateway,
      symbol,
      mode,
      QUOTE_ASSET,
      this.reconciliation.isOk(),
    );
    const decision = this.riskManager.evaluate(signal, riskCtx);
    await this.signalsService.record(signal, decision, mode);

    if (!decision.approved || !decision.qty) {
      this.logger.warn(`Cycle ${symbol}: ${side} entry rejected by risk (${decision.rejectReason})`);
      return;
    }

    const orderSide = entryOrderSide(side);
    const entryClientOrderId = generateClientOrderId(mode, symbol, lastCandle.closeTime, 'ENTRY');
    const entryOrder = await this.placeOrder({
      symbol,
      side: orderSide,
      type: 'MARKET',
      quantity: decision.qty,
      newClientOrderId: entryClientOrderId,
    });
    const entryPrice = entryOrder.price || signal.price;

    const tradeDoc = await this.tradesService.openPosition({
      symbol,
      side,
      strategy: signal.strategy,
      timeframe: this.strategyConfig.timeframe,
      entryReason: signal.reason,
      mode,
      entryPrice,
      qty: decision.qty,
      entryTime: new Date(lastCandle.closeTime),
      fees: 0,
      stopLoss: signal.stopLoss!,
      takeProfit: signal.takeProfit,
      status: 'OPEN',
    });

    await this.ordersService.create({
      tradeId: tradeDoc._id,
      symbol,
      clientOrderId: entryClientOrderId,
      binanceOrderId: entryOrder.orderId,
      type: 'MARKET',
      side: orderSide,
      price: entryPrice,
      qty: entryOrder.origQty,
      executedQty: entryOrder.executedQty,
      status: entryOrder.status,
      createdAt: new Date(entryOrder.createdAt),
      filledAt: new Date(),
    });

    this.logger.log(
      `Entered ${side} ${symbol} @ ${entryPrice} stop=${signal.stopLoss} tp=${signal.takeProfit ?? 'n/a'} qty=${decision.qty}`,
    );
    this.eventEmitter.emit(
      TRADE_OPENED,
      buildTradeOpenedEvent({
        _id: tradeDoc._id,
        symbol,
        side,
        mode,
        strategy: signal.strategy,
        timeframe: this.strategyConfig.timeframe,
        qty: decision.qty,
        entryPrice,
        stopLoss: signal.stopLoss!,
        takeProfit: signal.takeProfit,
        entryTime: new Date(lastCandle.closeTime),
        entryReason: signal.reason,
      }),
    );

    if (this.gateway.kind === 'BINANCE') {
      await this.placeStopOrRescue(tradeDoc, symbol, side, decision.qty, signal.stopLoss!, mode, lastCandle);
    }
  }

  private async placeStopOrRescue(
    tradeDoc: TradeDocument,
    symbol: string,
    side: TradeSide,
    qty: number,
    stopLoss: number,
    mode: TradeMode,
    lastCandle: Candle,
  ): Promise<void> {
    const stopClientOrderId = generateClientOrderId(mode, symbol, lastCandle.closeTime, 'STOP');
    const stopSide = exitOrderSide(side);
    // The limit sits past the trigger in the direction of the stop, so it fills once triggered:
    // below it for a long's SELL stop, above it for a short's BUY stop.
    const limitPrice =
      side === 'SHORT'
        ? stopLoss * (1 + this.config.stopLimitOffsetPct)
        : stopLoss * (1 - this.config.stopLimitOffsetPct);

    try {
      const stopOrder = await this.placeOrder({
        symbol,
        side: stopSide,
        type: 'STOP_LOSS_LIMIT',
        quantity: qty,
        price: limitPrice,
        stopPrice: stopLoss,
        newClientOrderId: stopClientOrderId,
      });
      await this.ordersService.create({
        tradeId: tradeDoc._id,
        symbol,
        clientOrderId: stopClientOrderId,
        binanceOrderId: stopOrder.orderId,
        type: 'STOP_LOSS_LIMIT',
        side: stopSide,
        price: limitPrice,
        qty,
        executedQty: 0,
        status: stopOrder.status,
        createdAt: new Date(),
      });
    } catch (err) {
      // A position must never be left without a stop - flatten immediately if we couldn't place one.
      const message = `CRITICAL: failed to place stop for ${symbol} (${(err as Error).message}) - closing at market.`;
      this.logger.error(message);
      this.eventEmitter.emit('alert.critical', { message });
      const emergencyClientOrderId = generateClientOrderId(mode, symbol, Date.now(), 'EXIT');
      const emergencyOrder = await this.placeOrder({
        symbol,
        side: stopSide,
        type: 'MARKET',
        quantity: qty,
        newClientOrderId: emergencyClientOrderId,
      });
      const closed = await this.tradesService.settlePosition(tradeDoc, {
        exitPrice: emergencyOrder.price || tradeDoc.entryPrice,
        exitTime: new Date(),
        exitReason: 'MANUAL',
        reasonDetail: 'stop order could not be placed',
      });
      await this.afterTradeClosed(closed);
    }
  }

  private async exitPosition(
    trade: TradeDocument,
    exitPrice: number,
    closeTime: number,
    reason: TradeExitReason,
    mode: TradeMode,
    symbol: string,
    reasonDetail?: string,
  ): Promise<void> {
    if (this.gateway.kind === 'BINANCE') {
      const openOrders = await this.ordersService.findByTradeId(trade._id);
      const stopOrder = openOrders.find(
        (o) => o.type === 'STOP_LOSS_LIMIT' && ['NEW', 'PARTIALLY_FILLED'].includes(o.status),
      );
      if (stopOrder) {
        await this.gateway.cancelOrder(symbol, stopOrder.clientOrderId).catch((err: Error) => {
          this.logger.warn(`Could not cancel stop order before exit: ${err.message}`);
        });
      }
    }

    const clientOrderId = generateClientOrderId(mode, symbol, closeTime, 'EXIT');
    const order = await this.placeOrder({
      symbol,
      side: exitOrderSide(trade.side),
      type: 'MARKET',
      quantity: trade.qty,
      newClientOrderId: clientOrderId,
    });
    const finalExitPrice = order.price || exitPrice;

    const closed = await this.tradesService.settlePosition(trade, {
      exitPrice: finalExitPrice,
      exitTime: new Date(closeTime),
      exitReason: reason,
      reasonDetail,
    });
    this.logger.log(`Exited ${trade.side} ${symbol} @ ${finalExitPrice} (${reason}) pnl=${closed.pnl.toFixed(2)}`);
    await this.afterTradeClosed(closed);
  }

  private async closePaperPosition(
    trade: TradeDocument,
    exitPrice: number,
    closeTime: number,
    reason: TradeExitReason,
  ): Promise<void> {
    await this.placeOrder({
      symbol: trade.symbol,
      side: exitOrderSide(trade.side),
      type: 'MARKET',
      quantity: trade.qty,
      newClientOrderId: generateClientOrderId('PAPER', trade.symbol, closeTime, 'EXIT'),
    });
    const closed = await this.tradesService.settlePosition(trade, {
      exitPrice,
      exitTime: new Date(closeTime),
      exitReason: reason,
    });
    this.logger.log(`Exited ${trade.side} ${trade.symbol} @ ${exitPrice} (${reason}) pnl=${closed.pnl.toFixed(2)}`);
    await this.afterTradeClosed(closed);
  }

  /** Emits the trade.closed domain event and auto-pauses the bot if risk thresholds are breached. */
  private async afterTradeClosed(closed: TradeClosedEvent): Promise<void> {
    this.eventEmitter.emit(TRADE_CLOSED, closed);

    const ctx = await this.riskContextBuilder.build(
      this.gateway,
      closed.symbol,
      closed.mode,
      QUOTE_ASSET,
      this.reconciliation.isOk(),
    );
    await this.controlService.checkAutoPauseConditions({
      dailyPnl: ctx.dailyPnl,
      accountEquity: ctx.accountEquity,
      maxDailyLossPct: this.riskConfigValues.maxDailyLossPct,
      consecutiveStopLosses: ctx.consecutiveStopLosses,
      maxConsecutiveStops: this.riskConfigValues.maxConsecutiveStops,
    });
  }

  /** Every order of a cycle goes through here, so a failed cycle knows whether it already traded. */
  private placeOrder(params: Parameters<ExchangeGateway['placeOrder']>[0]): ReturnType<ExchangeGateway['placeOrder']> {
    this.ordersPlacedInCycle.add(params.symbol);
    return this.gateway.placeOrder(params);
  }

  private async fetchClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    let candles: Candle[];
    try {
      candles = await this.gateway.getCandles({ symbol, interval, limit: limit + 2 });
    } catch (err) {
      // Tagged so the incident layer reports "Binance API" rather than a generic cycle failure.
      throw new MarketDataError((err as Error).message, err);
    }
    return candles.filter((c) => c.isClosed);
  }

  /** Confirms the loop is alive even when nothing happens for a while (no entries/exits). */
  @Interval(5 * 60_000)
  async heartbeat(): Promise<void> {
    if (!this.config.enabled) return;
    const mode = this.trading.mode;
    try {
      const [openTrades, balance] = await Promise.all([
        this.tradesService.countOpenPositions(mode),
        this.gateway.getBalance(QUOTE_ASSET).catch(() => undefined),
      ]);
      const equity = balance?.free ?? 0;
      this.logger.log(
        `${WORKER_LOG} heartbeat mode=${mode} openTrades=${openTrades} equity=${equity.toFixed(2)} lastCycle=${this.runtimeStatus.getLastCycleAgoLabel()}`,
      );
    } catch (err) {
      this.logger.warn(`${WORKER_LOG} heartbeat log failed: ${(err as Error).message}`);
    }
  }

  private tryEvaluate(
    evaluate: (ctx: StrategyContext) => Signal,
    symbol: string,
    candles: Candle[],
    regimeCandles: Candle[] | undefined,
    openPosition: StrategyContext['openPosition'],
  ): Signal | null {
    try {
      return evaluate({ symbol, candles, regimeCandles, openPosition });
    } catch {
      return null;
    }
  }
}
