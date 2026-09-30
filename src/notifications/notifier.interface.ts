export type NotificationLevel = 'info' | 'warning' | 'critical';

export interface Notifier {
  notify(message: string, level: NotificationLevel): Promise<void>;
}
