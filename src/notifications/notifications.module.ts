import { Module } from '@nestjs/common';
import { DiscordNotificationProvider } from './discord/discord-notification.provider';
import { NOTIFICATION_PROVIDERS, type NotificationProvider } from './notification.types';
import { NotificationsService } from './notifications.service';
import { SignalVetoDigestService } from './signal-veto-digest.service';
import { TelegramNotificationProvider } from './telegram/telegram-notification.provider';

/** Add a channel: implement NotificationProvider and list it in NOTIFICATION_PROVIDERS. */
@Module({
  providers: [
    TelegramNotificationProvider,
    DiscordNotificationProvider,
    {
      provide: NOTIFICATION_PROVIDERS,
      inject: [TelegramNotificationProvider, DiscordNotificationProvider],
      useFactory: (...providers: NotificationProvider[]) => providers,
    },
    NotificationsService,
    SignalVetoDigestService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
