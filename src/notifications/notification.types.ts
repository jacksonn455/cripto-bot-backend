import type { NotificationCategory } from '../config/configuration';
import type { TradeClosedEvent, TradeOpenedEvent } from '../trades/trade-events';

export type NotificationLevel = 'info' | 'warning' | 'critical';

/**
 * Operational notice from the incident layer (IncidentService / the heartbeat watchdog):
 * incident = a problem started; recovery = it ended (or the worker came back); restart = the
 * worker restarted after an unclean exit. Every value is already sanitized (no secrets, no stacks).
 */
export interface OpsNotice {
  phase: 'incident' | 'recovery' | 'restart';
  /** Title after "KRYPTO —", e.g. "INCIDENT", "WORKER OFFLINE", "RECOVERED", "RESTARTED". */
  headline: string;
  /** One operational sentence, e.g. "Binance API falhando para BTCUSDT". */
  summary: string;
  severity: NotificationLevel;
  /** Ordered facts shown as embed fields: [name, value]. */
  fields: Array<[string, string]>;
  /** Stable incident key (footer), e.g. MARKET_DATA:BTCUSDT. */
  incidentKey: string;
  /** ISO time of the notice. */
  at: string;
}

/** Everything a channel may be asked to deliver. Providers format each kind their own way. */
export type Notification =
  | { kind: 'alert'; level: NotificationLevel; message: string }
  | { kind: 'ops'; notice: OpsNotice }
  | { kind: 'trade.opened'; trade: TradeOpenedEvent }
  | { kind: 'trade.closed'; trade: TradeClosedEvent };

export interface DeliveryResult {
  delivered: boolean;
  /** Safe to log: never contains the webhook URL or token. */
  error?: string;
}

/**
 * One delivery channel (Telegram, Discord...). Trading code never talks to a provider: it emits
 * domain events and NotificationsService fans them out to every enabled provider.
 * `send` must never throw — a chat outage can't be allowed to affect a trade.
 */
export interface NotificationProvider {
  readonly name: string;
  isEnabled(): boolean;
  /** Whether this channel is configured to receive this kind of notification. */
  accepts(notification: Notification): boolean;
  send(notification: Notification): Promise<DeliveryResult>;
}

export const NOTIFICATION_PROVIDERS = Symbol('NOTIFICATION_PROVIDERS');

/** Ops notices count as `alerts` for channels filtered by category (Discord gates them with DISCORD_ALERTS_ENABLED). */
export function categoryOf(notification: Notification): NotificationCategory {
  return notification.kind === 'alert' || notification.kind === 'ops' ? 'alerts' : 'trades';
}

/** Short human label for logs. */
export function describeNotification(notification: Notification): string {
  if (notification.kind === 'alert') return `alert:${notification.level}`;
  if (notification.kind === 'ops') return `ops:${notification.notice.phase} ${notification.notice.incidentKey}`;
  const t = notification.trade;
  return `${notification.kind} ${t.side} ${t.symbol}`;
}

const EXIT_REASON_LABELS: Record<string, string> = {
  TP: 'Take profit',
  SL: 'Stop loss',
  TRAILING: 'Trailing stop',
  SIGNAL: 'Sinal da estratégia',
  MANUAL: 'Manual / emergência',
  KILL_SWITCH: 'Kill switch',
};

export function exitReasonLabel(reason: string): string {
  return EXIT_REASON_LABELS[reason] ?? reason;
}

export function formatDuration(fromIso: string, toIso: string): string {
  const ms = Math.max(0, new Date(toIso).getTime() - new Date(fromIso).getTime());
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, '0')}`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** Enough decimals for BTC quantities and sub-dollar prices, without trailing noise. */
export function formatNumber(value: number, maxDecimals = 8): string {
  if (!Number.isFinite(value)) return String(value);
  const decimals = Math.abs(value) >= 100 ? 2 : Math.abs(value) >= 1 ? 4 : maxDecimals;
  return Number(value.toFixed(decimals)).toString();
}

export function formatSigned(value: number, decimals = 2): string {
  const fixed = value.toFixed(decimals);
  return value > 0 ? `+${fixed}` : fixed;
}
