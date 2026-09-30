import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { executionConfig, tradingConfig } from '../config/configuration';
import { ControlService } from '../control/control.service';
import { EXCHANGE_GATEWAY } from '../exchange/exchange-gateway.interface';
import type { ExchangeGateway } from '../exchange/exchange-gateway.interface';
import { generateClientOrderId } from './client-order-id.util';
import { OrdersService } from '../trades/orders.service';
import { exitOrderSide } from '../trades/position-math.util';
import type { TradeMode } from '../trades/schemas/trade.schema';
import { TRADE_CLOSED } from '../trades/trade-events';
import { TradesService } from '../trades/trades.service';

/**
 * Syncs local orders/positions against the exchange. PAPER mode has nothing to reconcile
 * (no real exchange state exists), so it's always reported healthy. LIVE mode reconciliation
 * paths are implemented per Binance's documented order lifecycle but could not be verified
 * against a live testnet connection in this environment (see README) — verify before trusting
 * it with real orders.
 */
@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private ok = true;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(EXCHANGE_GATEWAY) private readonly gateway: ExchangeGateway,
    private readonly ordersService: OrdersService,
    private readonly tradesService: TradesService,
    private readonly controlService: ControlService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(tradingConfig.KEY) private readonly trading: ReturnType<typeof tradingConfig>,
    @Inject(executionConfig.KEY) private readonly config: ReturnType<typeof executionConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) return;
    await this.reconcile();
    this.timer = setInterval(
      () => void this.reconcile(),
      this.config.reconciliationIntervalMinutes * 60_000,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  isOk(): boolean {
    return this.ok;
  }

  async reconcile(): Promise<void> {
    const mode = this.trading.mode;
    if (mode === 'PAPER') {
      this.ok = true; // nothing real to reconcile against
      await this.recordResult(true);
      return;
    }

    try {
      const exchangeOpenOrders = await this.gateway.getOpenOrders();
      const exchangeClientIds = new Set(exchangeOpenOrders.map((o) => o.clientOrderId));
      const localPendingOrders = await this.ordersService.findAllOpen();

      for (const localOrder of localPendingOrders) {
        if (exchangeClientIds.has(localOrder.clientOrderId)) continue;
        await this.reconcileMissingOrder(localOrder, mode);
      }

      this.ok = true;
      await this.recordResult(true);
    } catch (err) {
      this.logger.error(`Reconciliation failed: ${(err as Error).message}`);
      this.ok = false;
      await this.recordResult(false);
    }
  }

  /** Persisting the outcome is bookkeeping: a Mongo outage must not abort bootstrap or crash the interval. */
  private async recordResult(ok: boolean): Promise<void> {
    try {
      await this.controlService.recordReconciliation(ok);
    } catch (err) {
      this.logger.error(`Could not record reconciliation result: ${(err as Error).message}`);
    }
  }

  private async reconcileMissingOrder(
    localOrder: { symbol: string; clientOrderId: string; type: string; tradeId: unknown },
    mode: TradeMode,
  ): Promise<void> {
    const realStatus = await this.gateway.getOrder(localOrder.symbol, localOrder.clientOrderId);
    if (!realStatus) {
      this.logger.warn(`Order ${localOrder.clientOrderId} not found on exchange during reconciliation`);
      return;
    }

    await this.ordersService.updateStatus(localOrder.clientOrderId, {
      status: realStatus.status,
      executedQty: realStatus.executedQty,
      binanceOrderId: realStatus.orderId,
      filledAt: realStatus.status === 'FILLED' ? new Date() : undefined,
    });

    if (localOrder.type !== 'STOP_LOSS_LIMIT') return;

    const trade = await this.tradesService.findOne(String(localOrder.tradeId)).catch(() => null);
    if (!trade || trade.status !== 'OPEN') return;

    if (realStatus.status === 'FILLED') {
      const closed = await this.tradesService.settlePosition(
        { ...trade, _id: String(localOrder.tradeId) },
        { exitPrice: realStatus.price, exitTime: new Date(), exitReason: 'SL', reasonDetail: 'stop order filled on the exchange' },
      );
      this.eventEmitter.emit(TRADE_CLOSED, closed);
      this.logger.log(`Reconciliation: stop fill detected for ${localOrder.symbol}, trade closed`);
      return;
    }

    if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(realStatus.status)) {
      const message =
        `CRITICAL: stop order for ${localOrder.symbol} disappeared (${realStatus.status}) without ` +
        'filling - closing position at market immediately.';
      this.logger.error(message);
      this.eventEmitter.emit('alert.critical', { message });
      const clientOrderId = generateClientOrderId(mode, localOrder.symbol, Date.now(), 'EXIT');
      const marketOrder = await this.gateway.placeOrder({
        symbol: localOrder.symbol,
        side: exitOrderSide(trade.side),
        type: 'MARKET',
        quantity: trade.qty,
        newClientOrderId: clientOrderId,
      });
      const closed = await this.tradesService.settlePosition(
        { ...trade, _id: String(localOrder.tradeId) },
        {
          exitPrice: marketOrder.price || trade.entryPrice,
          exitTime: new Date(),
          exitReason: 'MANUAL',
          reasonDetail: `stop order ${realStatus.status} without filling`,
        },
      );
      this.eventEmitter.emit(TRADE_CLOSED, closed);
    }
  }
}
