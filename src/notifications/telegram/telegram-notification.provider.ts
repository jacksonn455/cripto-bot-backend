import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { notificationsConfig } from '../../config/configuration';
import { deliverJson } from '../http-delivery.util';
import {
  categoryOf,
  DeliveryResult,
  describeNotification,
  exitReasonLabel,
  formatDuration,
  formatNumber,
  formatSigned,
  Notification,
  NotificationProvider,
} from '../notification.types';

const MAX_ATTEMPTS = 2;
const MAX_RETRY_DELAY_MS = 5_000;
const MAX_TEXT = 4096; // Bot API sendMessage limit

/**
 * Plain-text notifications through the Telegram Bot API (sendMessage). On as soon as
 * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set (TELEGRAM_ENABLED=false turns it off without
 * removing them); alerts only by default (TELEGRAM_EVENTS). The token is part of the URL, so
 * error messages are redacted before logging.
 */
@Injectable()
export class TelegramNotificationProvider implements NotificationProvider, OnModuleInit {
  readonly name = 'Telegram';
  private readonly logger = new Logger(TelegramNotificationProvider.name);

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly config: ReturnType<typeof notificationsConfig>,
  ) {}

  onModuleInit(): void {
    if (this.isEnabled()) {
      this.logger.log(`[Telegram] enabled, events: ${this.config.telegramEvents.join(', ')}`);
    }
  }

  isEnabled(): boolean {
    return this.config.telegramEnabled && Boolean(this.config.telegramBotToken && this.config.telegramChatId);
  }

  accepts(notification: Notification): boolean {
    return this.config.telegramEvents.includes(categoryOf(notification));
  }

  async send(notification: Notification): Promise<DeliveryResult> {
    if (!this.isEnabled()) return { delivered: false, error: 'disabled' };

    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
    const outcome = await deliverJson(
      url,
      {
        chat_id: this.config.telegramChatId,
        text: formatTelegramText(notification).slice(0, MAX_TEXT),
        disable_web_page_preview: true,
      },
      {
        timeoutMs: this.config.timeoutMs,
        maxAttempts: MAX_ATTEMPTS,
        maxRetryDelayMs: MAX_RETRY_DELAY_MS,
        secrets: [this.config.telegramBotToken],
      },
    );

    const label = describeNotification(notification);
    if (outcome.ok) {
      this.logger.log(`[Telegram] notification sent (${label})`);
      return { delivered: true };
    }
    this.logger.warn(`[Telegram] notification failed (${label}) after ${outcome.attempts} attempt(s): ${outcome.error}`);
    return { delivered: false, error: outcome.error };
  }
}

export function formatTelegramText(notification: Notification): string {
  if (notification.kind === 'alert') {
    return `[${notification.level.toUpperCase()}] ${notification.message}`;
  }
  if (notification.kind === 'trade.opened') {
    const t = notification.trade;
    return [
      `${t.side} aberto: ${t.symbol} (${t.mode}, ${t.timeframe ?? 'n/d'})`,
      `Entrada ${formatNumber(t.entryPrice)} · qtd ${formatNumber(t.qty)} · stop ${formatNumber(t.stopLoss)}`,
      `Estratégia: ${t.strategy}`,
      ...(t.signalReason ? [`Sinal: ${t.signalReason}`] : []),
    ].join('\n');
  }
  const c = notification.trade;
  return [
    `${c.side} fechado: ${c.symbol} (${c.mode}, ${c.timeframe ?? 'n/d'}) ${formatSigned(c.pnlPct)}%`,
    `Entrada ${formatNumber(c.entryPrice)} -> saída ${formatNumber(c.exitPrice)} · qtd ${formatNumber(c.qty)}`,
    `PnL ${formatSigned(c.pnl)} USDT · motivo: ${exitReasonLabel(c.reason)} · duração ${formatDuration(c.entryTime, c.exitTime)}`,
    `Estratégia: ${c.strategy}`,
  ].join('\n');
}
