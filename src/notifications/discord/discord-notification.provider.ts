import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { notificationsConfig } from '../../config/configuration';
import { deliverJson, maskWebhookUrl } from '../http-delivery.util';
import {
  categoryOf,
  DeliveryResult,
  describeNotification,
  Notification,
  NotificationProvider,
} from '../notification.types';
import { buildDiscordPayload } from './discord-embed.formatter';

const MAX_ATTEMPTS = 2;
const MAX_RETRY_DELAY_MS = 5_000;

/**
 * Posts trade/alert notifications as embeds through a Discord webhook (Execute Webhook API).
 * On when DISCORD_ENABLED=true and DISCORD_WEBHOOK_URL is set. The webhook URL is a secret (it
 * embeds the token): it is never logged — only host + webhook id.
 */
@Injectable()
export class DiscordNotificationProvider implements NotificationProvider, OnModuleInit {
  readonly name = 'Discord';
  private readonly logger = new Logger(DiscordNotificationProvider.name);
  /** Set when Discord answered 401/403/404: the webhook was deleted or the URL is wrong. */
  private disabledReason?: string;

  constructor(
    @Inject(notificationsConfig.KEY)
    private readonly config: ReturnType<typeof notificationsConfig>,
  ) {}

  onModuleInit(): void {
    if (this.config.discordEnabled && !this.config.discordWebhookUrl) {
      this.logger.warn('[Discord] DISCORD_ENABLED=true but DISCORD_WEBHOOK_URL is empty - Discord disabled');
    } else if (this.isEnabled()) {
      this.logger.log(
        `[Discord] enabled (${maskWebhookUrl(this.config.discordWebhookUrl)}), events: ${this.config.discordEvents.join(', ')}`,
      );
    }
  }

  isEnabled(): boolean {
    return this.config.discordEnabled && Boolean(this.config.discordWebhookUrl) && !this.disabledReason;
  }

  accepts(notification: Notification): boolean {
    // Operational incidents have their own switch, independent of DISCORD_EVENTS (trades/alerts).
    if (notification.kind === 'ops') return this.config.discordAlertsEnabled;
    return this.config.discordEvents.includes(categoryOf(notification));
  }

  async send(notification: Notification): Promise<DeliveryResult> {
    if (!this.isEnabled()) return { delivered: false, error: this.disabledReason ?? 'disabled' };

    const outcome = await deliverJson(
      this.config.discordWebhookUrl,
      buildDiscordPayload(notification, this.config.discordUsername),
      {
        timeoutMs: this.config.timeoutMs,
        maxAttempts: MAX_ATTEMPTS,
        maxRetryDelayMs: MAX_RETRY_DELAY_MS,
        secrets: [this.config.discordWebhookUrl, this.webhookToken()],
      },
    );

    const label = describeNotification(notification);
    if (outcome.ok) {
      this.logger.log(`[Discord] notification sent (${label})`);
      return { delivered: true };
    }

    if (outcome.permanent) {
      // Discord's guidance: stop using a webhook that returns 404. Until the next restart (with a fixed env).
      this.disabledReason = `webhook rejected (${outcome.error})`;
      this.logger.error(`[Discord] notification failed (${label}): ${outcome.error} - disabling Discord until restart`);
    } else {
      this.logger.warn(`[Discord] notification failed (${label}) after ${outcome.attempts} attempt(s): ${outcome.error}`);
    }
    return { delivered: false, error: outcome.error };
  }

  private webhookToken(): string {
    return this.config.discordWebhookUrl.split('/').pop() ?? '';
  }
}
