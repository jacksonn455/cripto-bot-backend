import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { executionConfig, riskConfig, tradingConfig, trendRegimeConfig } from '../config/configuration';
import { ControlService } from '../control/control.service';
import { RuntimeStatusService } from '../control/runtime-status.service';
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
import type { TradeDocument, TradeExitReason, TradeMode } from '../trades/schemas/trade.schema';
import { TradesService } from '../trades/trades.service';
import { generateClientOrderId } from './client-order-id.util';
import { ReconciliationService } from './reconciliation.service';

const QUOTE_ASSET = 'USDT'; // v1: all configured pairs are USDT-quoted (BTCUSDT, ETHUSDT).

@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly lastProcessedCloseTime = new Map<string, number>();

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
  ) {}

  async runCycle(symbol: string, strategyName: string): Promise<void> {
    const mode = this.trading.mode;
    const strategy = this.strategyRegistry.get(strategyName);

    const candles = await this.fetchClosedCandles(
      symbol,
      this.strategyConfig.timeframe,
      this.strategyConfig.emaRegime + 10,
    );
    const lastCandle = candles[candles.length - 1];
    if (!lastCandle) return;

    const dedupeKey = `${mode}:${symbol}`;
    if (this.lastProcessedCloseTime.get(dedupeKey) === lastCandle.closeTime) return;
    this.lastProcessedCloseTime.set(dedupeKey, lastCandle.closeTime);

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
        const intraExit = checkIntraCandleExit(
          { stopLoss: openTrade.stopLoss, takeProfit: openTrade.takeProfit },
          lastCandle,
        );
        if (intraExit) {
          await this.closePaperPosition(openTrade, intraExit.exitPrice, lastCandle.closeTime, intraExit.reason);
          openTrade = null;
        }
      }

      if (openTrade) {
        const signal = this.tryEvaluate(strategy.onCandleClosed.bind(strategy), symbol, candles, regimeCandles, {
          side: openTrade.side === 'LONG' ? 'LONG' : 'SHORT',
          entryPrice: openTrade.entryPrice,
          stopLoss: openTrade.stopLoss,
        });
        this.logCycle(symbol, signal);
        if (signal?.action === 'EXIT') {
          await this.exitPosition(openTrade, signal.price, lastCandle.closeTime, 'SIGNAL', mode, symbol);
          openTrade = null;
        }
      }
    }

    if (!openTrade) {
      const signal = this.tryEvaluate(strategy.onCandleClosed.bind(strategy), symbol, candles, regimeCandles, null);
      this.logCycle(symbol, signal);
      if (signal && (signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT')) {
        await this.tryEnter(signal, symbol, mode, lastCandle);
      }
    }
  }

  /** Logs signal=HOLD/ENTER_LONG/EXIT/SKIP + reason every cycle, not just entries/exits. */
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
      this.logger.warn(`Cycle ${symbol}: entry rejected by risk (${decision.rejectReason})`);
      return;
    }

    const entryClientOrderId = generateClientOrderId(mode, symbol, lastCandle.closeTime, 'ENTRY');
    const entryOrder = await this.gateway.placeOrder({
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity: decision.qty,
      newClientOrderId: entryClientOrderId,
    });
    const entryPrice = entryOrder.price || signal.price;

    const tradeDoc = await this.tradesService.openPosition({
      symbol,
      side: 'LONG',
      strategy: signal.strategy,
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
      side: 'BUY',
      price: entryPrice,
      qty: entryOrder.origQty,
      executedQty: entryOrder.executedQty,
      status: entryOrder.status,
      createdAt: new Date(entryOrder.createdAt),
      filledAt: new Date(),
    });

    this.logger.log(
      `Entered ${symbol} @ ${entryPrice} stop=${signal.stopLoss} tp=${signal.takeProfit ?? 'n/a'} qty=${decision.qty}`,
    );
    this.eventEmitter.emit('trade.opened', {
      symbol,
      side: 'LONG',
      qty: decision.qty,
      entryPrice,
      stopLoss: signal.stopLoss,
      mode,
    });

    if (this.gateway.kind === 'BINANCE') {
      await this.placeStopOrRescue(tradeDoc, symbol, decision.qty, signal.stopLoss!, mode, lastCandle);
    }
  }

  private async placeStopOrRescue(
    tradeDoc: TradeDocument,
    symbol: string,
    qty: number,
    stopLoss: number,
    mode: TradeMode,
    lastCandle: Candle,
  ): Promise<void> {
    const stopClientOrderId = generateClientOrderId(mode, symbol, lastCandle.closeTime, 'STOP');
    const limitPrice = stopLoss * (1 - this.config.stopLimitOffsetPct);

    try {
      const stopOrder = await this.gateway.placeOrder({
        symbol,
        side: 'SELL',
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
        side: 'SELL',
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
      const emergencyOrder = await this.gateway.placeOrder({
        symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: qty,
        newClientOrderId: emergencyClientOrderId,
      });
      const exitPrice = emergencyOrder.price || tradeDoc.entryPrice;
      const pnl = (exitPrice - tradeDoc.entryPrice) * qty;
      await this.tradesService.closePosition(String(tradeDoc._id), {
        exitPrice,
        exitTime: new Date(),
        fees: 0,
        pnl,
        pnlPct: ((exitPrice - tradeDoc.entryPrice) / tradeDoc.entryPrice) * 100,
        exitReason: 'MANUAL',
      });
      await this.afterTradeClosed(symbol, mode, pnl, 'MANUAL');
    }
  }

  private async exitPosition(
    trade: TradeDocument,
    exitPrice: number,
    closeTime: number,
    reason: TradeExitReason,
    mode: TradeMode,
    symbol: string,
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
    const order = await this.gateway.placeOrder({
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: trade.qty,
      newClientOrderId: clientOrderId,
    });
    const finalExitPrice = order.price || exitPrice;
    const pnl = (finalExitPrice - trade.entryPrice) * trade.qty;

    await this.tradesService.closePosition(String(trade._id), {
      exitPrice: finalExitPrice,
      exitTime: new Date(closeTime),
      fees: 0,
      pnl,
      pnlPct: ((finalExitPrice - trade.entryPrice) / trade.entryPrice) * 100,
      exitReason: reason,
    });
    this.logger.log(`Exited ${symbol} @ ${finalExitPrice} (${reason})`);
    await this.afterTradeClosed(symbol, mode, pnl, reason);
  }

  private async closePaperPosition(
    trade: TradeDocument,
    exitPrice: number,
    closeTime: number,
    reason: TradeExitReason,
  ): Promise<void> {
    await this.gateway.placeOrder({
      symbol: trade.symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: trade.qty,
      newClientOrderId: generateClientOrderId('PAPER', trade.symbol, closeTime, 'EXIT'),
    });
    const pnl = (exitPrice - trade.entryPrice) * trade.qty;
    await this.tradesService.closePosition(String(trade._id), {
      exitPrice,
      exitTime: new Date(closeTime),
      fees: 0,
      pnl,
      pnlPct: ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100,
      exitReason: reason,
    });
    this.logger.log(`Exited ${trade.symbol} @ ${exitPrice} (${reason})`);
    await this.afterTradeClosed(trade.symbol, 'PAPER', pnl, reason);
  }

  /** Emits the trade.closed domain event and auto-pauses the bot if risk thresholds are breached. */
  private async afterTradeClosed(
    symbol: string,
    mode: TradeMode,
    pnl: number,
    reason: TradeExitReason,
  ): Promise<void> {
    this.eventEmitter.emit('trade.closed', { symbol, pnl, reason, mode });

    const ctx = await this.riskContextBuilder.build(
      this.gateway,
      symbol,
      mode,
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

  private async fetchClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const candles = await this.gateway.getCandles({ symbol, interval, limit: limit + 2 });
    return candles.filter((c) => c.isClosed);
  }

  /** Confirms the loop is alive even when nothing happens for a while (no entries/exits). */
  @Interval(5 * 60_000)
  async heartbeat(): Promise<void> {
    if (!this.config.enabled) return;
    const mode = this.trading.mode;
    const [openTrades, balance] = await Promise.all([
      this.tradesService.countOpenPositions(mode),
      this.gateway.getBalance(QUOTE_ASSET).catch(() => undefined),
    ]);
    const equity = balance?.free ?? 0;
    this.logger.log(
      `Heartbeat: mode=${mode}, openTrades=${openTrades}, equity=${equity.toFixed(2)}, lastCycle=${this.runtimeStatus.getLastCycleAgoLabel()}`,
    );
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
