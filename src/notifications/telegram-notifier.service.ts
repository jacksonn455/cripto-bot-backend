import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { notificationsConfig } from '../config/configuration';
import { NotificationLevel, Notifier } from './notifier.interface';

/**
 * Sends alerts to Telegram when configured; always logs regardless, so nothing is silently
 * lost if TELEGRAM_BOT_TOKEN/CHAT_ID aren't set. Reacts to domain events emitted elsewhere
 * (execution, reconciliation, control) instead of being called directly — keeps those
 * services decoupled from how/whether alerts get delivered.
 */
@Injectable()
export class TelegramNotifierService implements Notifier, OnModuleInit {
  private readonly logger = new Logger(TelegramNotifierService.name);
  private enabled = false;

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly config: ReturnType<typeof notificationsConfig>,
  ) {}

  onModuleInit(): void {
    this.enabled = Boolean(this.config.telegramBotToken && this.config.telegramChatId);
    if (!this.enabled) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set - notifications will only be logged',
      );
    }
  }

  async notify(message: string, level: NotificationLevel): Promise<void> {
    this.logger.log(`[${level.toUpperCase()}] ${message}`);
    if (!this.enabled) return;

    try {
      const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text: `[${level.toUpperCase()}] ${message}`,
        }),
      });
    } catch (err) {
      this.logger.error(`Failed to send Telegram notification: ${(err as Error).message}`);
    }
  }

  @OnEvent('alert.critical')
  handleCriticalAlert(payload: { message: string }): void {
    void this.notify(payload.message, 'critical');
  }

  @OnEvent('bot.paused')
  handleBotPaused(payload: { reason: string }): void {
    void this.notify(`Bot paused: ${payload.reason}`, 'warning');
  }
}
