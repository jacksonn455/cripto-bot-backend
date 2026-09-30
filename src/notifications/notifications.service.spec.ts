import { Logger } from '@nestjs/common';
import type { Notification, NotificationProvider } from './notification.types';
import { NotificationsService } from './notifications.service';
import { formatTelegramText, TelegramNotificationProvider } from './telegram/telegram-notification.provider';

function fakeProvider(name: string, opts: { enabled?: boolean; accepts?: boolean; fails?: 'reject' | 'hang' } = {}) {
  const send = jest.fn<Promise<{ delivered: boolean }>, [Notification]>(() => {
    if (opts.fails === 'reject') return Promise.reject(new Error(`${name} exploded`));
    return Promise.resolve({ delivered: true });
  });
  const provider: NotificationProvider = {
    name,
    isEnabled: () => opts.enabled ?? true,
    accepts: () => opts.accepts ?? true,
    send,
  };
  return { provider, send };
}

const alert: Notification = { kind: 'alert', level: 'critical', message: 'boom' };

describe('NotificationsService', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('delivers to every enabled channel that accepts the notification', async () => {
    const discord = fakeProvider('Discord');
    const telegram = fakeProvider('Telegram', { accepts: false });
    const disabled = fakeProvider('Off', { enabled: false });

    await new NotificationsService([discord.provider, telegram.provider, disabled.provider]).dispatch(alert);

    expect(discord.send).toHaveBeenCalledWith(alert);
    expect(telegram.send).not.toHaveBeenCalled();
    expect(disabled.send).not.toHaveBeenCalled();
  });

  it('isolates a failing channel: the others still receive it and dispatch never throws', async () => {
    const broken = fakeProvider('Broken', { fails: 'reject' });
    const discord = fakeProvider('Discord');

    await expect(new NotificationsService([broken.provider, discord.provider]).dispatch(alert)).resolves.toBeUndefined();
    expect(discord.send).toHaveBeenCalled();
  });

  it('event handlers return synchronously (the emitting trade code never waits on a channel)', () => {
    const slow: NotificationProvider = {
      name: 'Slow',
      isEnabled: () => true,
      accepts: () => true,
      send: () => new Promise(() => undefined), // never resolves
    };
    const service = new NotificationsService([slow]);
    expect(service.onCriticalAlert({ message: 'x' })).toBeUndefined();
    expect(service.onBotPaused({ reason: 'KILL_SWITCH' })).toBeUndefined();
  });

  it('maps domain events to notifications', async () => {
    const discord = fakeProvider('Discord');
    const service = new NotificationsService([discord.provider]);

    service.onBotPaused({ reason: 'DAILY_LOSS_LIMIT' });
    await new Promise((r) => setImmediate(r));

    expect(discord.send).toHaveBeenCalledWith({ kind: 'alert', level: 'warning', message: 'Bot paused: DAILY_LOSS_LIMIT' });
  });
});

describe('TelegramNotificationProvider', () => {
  const config = {
    telegramEnabled: true,
    telegramBotToken: '123456:SECRET-token',
    telegramChatId: '42',
    telegramEvents: ['alerts'],
    discordEnabled: false,
    discordWebhookUrl: '',
    discordUsername: 'Trade Bot',
    discordEvents: ['alerts', 'trades'],
    timeoutMs: 200,
  };
  let logs: string[];

  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        const m = args[0];
        logs.push(String(m));
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps its original default: on with token + chat id, alerts only', () => {
    const provider = new TelegramNotificationProvider(config as never);
    expect(provider.isEnabled()).toBe(true);
    expect(provider.accepts(alert)).toBe(true);
    expect(provider.accepts({ kind: 'trade.closed', trade: {} as never })).toBe(false);
    expect(new TelegramNotificationProvider({ ...config, telegramChatId: '' } as never).isEnabled()).toBe(false);
    expect(new TelegramNotificationProvider({ ...config, telegramEnabled: false } as never).isEnabled()).toBe(false);
  });

  it('checks the Bot API answer and never logs the token', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 }));

    const result = await new TelegramNotificationProvider(config as never).send(alert);

    expect(result).toEqual({ delivered: false, error: 'HTTP 400: Bad Request: chat not found' });
    expect(logs.join('\n')).not.toContain('SECRET-token');
  });

  it('sends the formatted text to sendMessage', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    await expect(new TelegramNotificationProvider(config as never).send(alert)).resolves.toEqual({ delivered: true });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42', text: '[CRITICAL] boom' });
  });

  it('formats closed trades with side, pnl and reason', () => {
    const text = formatTelegramText({
      kind: 'trade.closed',
      trade: {
        tradeId: 't',
        symbol: 'ETHUSDT',
        side: 'LONG',
        mode: 'PAPER',
        strategy: 'TrendRegimeStrategy',
        timeframe: '1h',
        qty: 1,
        entryPrice: 2000,
        exitPrice: 1950,
        pnl: -50,
        pnlPct: -2.5,
        fees: 0,
        reason: 'SL',
        entryTime: '2026-09-30T10:00:00.000Z',
        exitTime: '2026-09-30T12:00:00.000Z',
      },
    });
    expect(text).toContain('LONG fechado: ETHUSDT (PAPER, 1h) -2.50%');
    expect(text).toContain('PnL -50.00 USDT · motivo: Stop loss · duração 2h00');
  });
});
