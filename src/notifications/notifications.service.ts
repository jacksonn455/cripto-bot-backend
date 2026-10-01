import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TRADE_CLOSED, TRADE_OPENED, type TradeClosedEvent, type TradeOpenedEvent } from '../trades/trade-events';
import {
  describeNotification,
  Notification,
  NOTIFICATION_PROVIDERS,
  type NotificationProvider,
} from './notification.types';


/**
 * Reacts to domain events emitted elsewhere (execution, reconciliation, control) and fans them
 * out to every enabled channel — trading code never knows whether/how alerts get delivered.
 * Always logs the notification locally too, so nothing is silently lost when no channel is set.
 * Delivery is fire-and-forget: handlers return immediately and a failing or slow channel only
 * produces a log line, never an exception in the emitting code.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@Inject(NOTIFICATION_PROVIDERS) private readonly providers: NotificationProvider[]) {}

  onModuleInit(): void {
    const enabled = this.providers.filter((p) => p.isEnabled()).map((p) => p.name);
    if (enabled.length === 0) {
      this.logger.warn('No notification channel configured (Discord/Telegram) - notifications will only be logged');
    } else {
      this.logger.log(`Notification channels: ${enabled.join(', ')}`);
    }
  }

  /** Delivers to every enabled channel that accepts this kind; resolves when all attempts settle. */
  async dispatch(notification: Notification): Promise<void> {
    this.logger.log(`[Notification] ${describeNotification(notification)}${this.summary(notification)}`);
    const targets = this.providers.filter((p) => p.isEnabled() && p.accepts(notification));
    await Promise.allSettled(
      targets.map((p) =>
        p.send(notification).catch((err: Error) => {
          // Providers are written not to throw; this is the last line of defense.
          this.logger.error(`[${p.name}] unexpected notification error: ${err.message}`);
        }),
      ),
    );
  }

  @OnEvent(TRADE_OPENED)
  onTradeOpened(trade: TradeOpenedEvent): void {
    void this.dispatch({ kind: 'trade.opened', trade });
  }

  @OnEvent(TRADE_CLOSED)
  onTradeClosed(trade: TradeClosedEvent): void {
    void this.dispatch({ kind: 'trade.closed', trade });
  }

  @OnEvent('alert.critical')
  onCriticalAlert(payload: { message: string }): void {
    void this.dispatch({ kind: 'alert', level: 'critical', message: payload.message });
  }

  @OnEvent('bot.paused')
  onBotPaused(payload: { reason: string }): void {
    void this.dispatch({ kind: 'alert', level: 'warning', message: `Bot paused: ${payload.reason}` });
  }

  @OnEvent('bot.resumed')
  onBotResumed(): void {
    void this.dispatch({ kind: 'alert', level: 'info', message: 'Bot resumed' });
  }

  private summary(notification: Notification): string {
    if (notification.kind === 'alert') return `: ${notification.message}`;
    if (notification.kind === 'ops') return `: ${notification.notice.headline} - ${notification.notice.summary}`;
    if (notification.kind === 'trade.opened') return ` @ ${notification.trade.entryPrice}`;
    return ` pnl=${notification.trade.pnl.toFixed(2)} (${notification.trade.reason})`;
  }
}
