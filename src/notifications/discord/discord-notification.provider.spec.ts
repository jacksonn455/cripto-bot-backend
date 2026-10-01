import { Logger } from '@nestjs/common';
import type { TradeClosedEvent, TradeOpenedEvent } from '../../trades/trade-events';
import type { Notification } from '../notification.types';
import { buildDiscordPayload } from './discord-embed.formatter';
import { DiscordNotificationProvider } from './discord-notification.provider';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/SuperSecretToken_abc-XYZ';

function makeProvider(overrides: Record<string, unknown> = {}) {
  return new DiscordNotificationProvider({
    telegramEnabled: true,
    telegramBotToken: '',
    telegramChatId: '',
    telegramEvents: ['alerts'],
    discordEnabled: true,
    discordWebhookUrl: WEBHOOK,
    discordUsername: 'Trade Bot',
    discordEvents: ['alerts', 'trades'],
    timeoutMs: 200,
    ...overrides,
  } as never);
}

const OPENED: TradeOpenedEvent = {
  tradeId: 't1',
  symbol: 'BTCUSDT',
  side: 'SHORT',
  mode: 'PAPER',
  strategy: 'TrendRegimeStrategy',
  timeframe: '1h',
  qty: 0.015,
  entryPrice: 62_000.5,
  stopLoss: 63_100,
  entryTime: '2026-09-30T10:00:00.000Z',
  signalReason: 'EMA20 cruzou abaixo da EMA50',
};

const CLOSED: TradeClosedEvent = {
  tradeId: 't1',
  symbol: 'BTCUSDT',
  side: 'SHORT',
  mode: 'PAPER',
  strategy: 'TrendRegimeStrategy',
  timeframe: '1h',
  qty: 0.015,
  entryPrice: 62_000,
  exitPrice: 61_000,
  pnl: 15,
  pnlPct: 1.6129,
  fees: 0,
  reason: 'SIGNAL',
  reasonDetail: 'EMA20 cruzou acima da EMA50',
  entryTime: '2026-09-30T10:00:00.000Z',
  exitTime: '2026-09-30T15:30:00.000Z',
};

const tradeClosed: Notification = { kind: 'trade.closed', trade: CLOSED };

function response(status: number, body: unknown = '', headers: Record<string, string> = {}) {
  // A 204 (Discord's reply without ?wait=true) can't carry a body.
  const payload = status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, { status, headers });
}

describe('DiscordNotificationProvider', () => {
  let fetchSpy: jest.SpyInstance;
  let logs: string[];

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        const msg = args[0];
        logs.push(String(msg));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('posts an embed to the webhook and reports delivery', async () => {
    fetchSpy.mockResolvedValue(response(204));

    const result = await makeProvider().send(tradeClosed);

    expect(result).toEqual({ delivered: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    const body = JSON.parse(init.body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.username).toBe('Trade Bot');
    expect(body.embeds[0].title).toContain('SHORT fechado');
    expect(logs.some((l) => l.includes('[Discord] notification sent'))).toBe(true);
  });

  it('never throws and never logs the webhook URL or token when Discord errors', async () => {
    fetchSpy.mockResolvedValue(response(500, { message: 'internal' }));

    const result = await makeProvider().send(tradeClosed);

    expect(result.delivered).toBe(false);
    expect(result.error).toContain('HTTP 500');
    // 5xx is retried once, then given up.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l.includes('[Discord] notification failed'))).toBe(true);
    expect(logs.join('\n')).not.toContain('SuperSecretToken');
  });

  it('redacts the webhook from network error messages', async () => {
    fetchSpy.mockRejectedValue(new Error(`connect ECONNREFUSED while calling ${WEBHOOK}`));

    const result = await makeProvider().send(tradeClosed);

    expect(result.delivered).toBe(false);
    expect(result.error).toContain('[redacted]');
    expect(result.error).not.toContain('SuperSecretToken');
    expect(logs.join('\n')).not.toContain('SuperSecretToken');
  });

  it('times out a hanging request without retrying (it may have been delivered)', async () => {
    fetchSpy.mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );

    const started = Date.now();
    const result = await makeProvider({ timeoutMs: 50 }).send(tradeClosed);

    expect(result).toEqual({ delivered: false, error: 'timeout after 50ms' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('honors a short 429 retry_after once, then succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(response(429, { message: 'You are being rate limited.', retry_after: 0.01, global: false }))
      .mockResolvedValueOnce(response(204));

    await expect(makeProvider().send(tradeClosed)).resolves.toEqual({ delivered: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('drops (does not queue) when the 429 retry_after is too long', async () => {
    fetchSpy.mockResolvedValue(response(429, { retry_after: 60 }));

    const result = await makeProvider().send(tradeClosed);

    expect(result.delivered).toBe(false);
    expect(result.error).toContain('rate limited');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stops using a webhook Discord says is gone (404)', async () => {
    fetchSpy.mockResolvedValue(response(404, { message: 'Unknown Webhook', code: 10015 }));
    const provider = makeProvider();

    await provider.send(tradeClosed);
    const second = await provider.send(tradeClosed);

    expect(provider.isEnabled()).toBe(false);
    expect(second.delivered).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is disabled (no HTTP call) when DISCORD_ENABLED=false or the URL is missing', async () => {
    const off = makeProvider({ discordEnabled: false });
    const noUrl = makeProvider({ discordWebhookUrl: '' });

    expect(off.isEnabled()).toBe(false);
    expect(noUrl.isEnabled()).toBe(false);
    await expect(off.send(tradeClosed)).resolves.toMatchObject({ delivered: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('filters by DISCORD_EVENTS', () => {
    const alertsOnly = makeProvider({ discordEvents: ['alerts'] });
    expect(alertsOnly.accepts(tradeClosed)).toBe(false);
    expect(alertsOnly.accepts({ kind: 'alert', level: 'critical', message: 'x' })).toBe(true);
  });
});

describe('buildDiscordPayload', () => {
  it('describes an opened SHORT with every trade detail', () => {
    const embed = buildDiscordPayload({ kind: 'trade.opened', trade: OPENED }).embeds[0];
    const fields = Object.fromEntries(embed.fields!.map((f) => [f.name, f.value]));

    expect(embed.title).toBe('🔻 SHORT aberto · BTCUSDT');
    expect(embed.description).toBe('EMA20 cruzou abaixo da EMA50');
    expect(embed.timestamp).toBe(OPENED.entryTime);
    expect(fields).toMatchObject({
      Lado: 'SHORT',
      Modo: 'PAPER',
      Timeframe: '1h',
      Estratégia: 'TrendRegimeStrategy',
      'Preço de entrada': '62000.5',
      Quantidade: '0.015',
      'Stop loss': '63100',
    });
    expect(fields['Take profit']).toBeUndefined();
  });

  it('describes a closed trade with pnl, %, reason and duration, green on profit', () => {
    const embed = buildDiscordPayload(tradeClosed).embeds[0];
    const fields = Object.fromEntries(embed.fields!.map((f) => [f.name, f.value]));

    expect(embed.title).toBe('✅ SHORT fechado · BTCUSDT · +1.61%');
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.timestamp).toBe(CLOSED.exitTime);
    expect(fields).toMatchObject({
      Entrada: '62000',
      Saída: '61000',
      PnL: '+15.00 USDT',
      Resultado: '+1.61%',
      Motivo: 'Sinal da estratégia',
      Duração: '5h30',
    });
  });

  it('is red on a loss', () => {
    const embed = buildDiscordPayload({ kind: 'trade.closed', trade: { ...CLOSED, pnl: -3, pnlPct: -0.5, reason: 'SL' } }).embeds[0];
    expect(embed.color).toBe(0xe74c3c);
    expect(embed.title).toContain('❌ SHORT fechado');
  });

  it('truncates oversized text to Discord limits instead of getting a 400', () => {
    const embed = buildDiscordPayload({ kind: 'alert', level: 'critical', message: 'x'.repeat(10_000) }).embeds[0];
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.title).toBe('🚨 Alerta crítico');
  });
});

describe('Discord operational incidents (same webhook as trades)', () => {
  const INCIDENT: Notification = {
    kind: 'ops',
    notice: {
      phase: 'incident',
      headline: 'INCIDENT',
      summary: 'Binance API (market data) · BTCUSDT: timeout',
      severity: 'warning',
      fields: [
        ['Componente', 'Binance API (market data)'],
        ['Status', 'DEGRADED'],
      ],
      incidentKey: 'MARKET_DATA:BTCUSDT',
      at: '2026-10-01T05:41:18.000Z',
    },
  };
  const TRADE: Notification = { kind: 'trade.opened', trade: OPENED };

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('accepts incidents by default, through the same provider/webhook as trades', () => {
    const p = makeProvider({ discordAlertsEnabled: true });
    expect(p.accepts(INCIDENT)).toBe(true);
    expect(p.accepts(TRADE)).toBe(true);
  });

  it('DISCORD_ALERTS_ENABLED=false: trades keep flowing, incidents are not sent', () => {
    const p = makeProvider({ discordAlertsEnabled: false });
    expect(p.accepts(TRADE)).toBe(true);
    expect(p.accepts(INCIDENT)).toBe(false);
  });

  it('DISCORD_ENABLED=false: no request to Discord at all', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const p = makeProvider({ discordEnabled: false, discordAlertsEnabled: true });
    await expect(p.send(INCIDENT)).resolves.toEqual({ delivered: false, error: 'disabled' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders incident / recovery / restart embeds consistent with the trade embeds', () => {
    const incident = buildDiscordPayload(INCIDENT, 'Trade Bot').embeds[0];
    expect(incident.title).toBe('⚠️ KRYPTO — INCIDENT');
    expect(incident.fields).toEqual([
      { name: 'Componente', value: 'Binance API (market data)', inline: true },
      { name: 'Status', value: 'DEGRADED', inline: true },
    ]);
    expect(incident.footer?.text).toBe('incidente MARKET_DATA:BTCUSDT');

    const critical = buildDiscordPayload({ kind: 'ops', notice: { ...(INCIDENT as Extract<Notification, { kind: 'ops' }>).notice, severity: 'critical', headline: 'WORKER OFFLINE' } } as Notification).embeds[0];
    expect(critical.title).toBe('🚨 KRYPTO — WORKER OFFLINE');
    const recovered = buildDiscordPayload({ kind: 'ops', notice: { ...(INCIDENT as Extract<Notification, { kind: 'ops' }>).notice, phase: 'recovery', headline: 'RECOVERED' } } as Notification).embeds[0];
    expect(recovered.title).toBe('✅ KRYPTO — RECOVERED');
    const restarted = buildDiscordPayload({ kind: 'ops', notice: { ...(INCIDENT as Extract<Notification, { kind: 'ops' }>).notice, phase: 'restart', headline: 'RESTARTED' } } as Notification).embeds[0];
    expect(restarted.title).toBe('🔄 KRYPTO — RESTARTED');
  });
});
