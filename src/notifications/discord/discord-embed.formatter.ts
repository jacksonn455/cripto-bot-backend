import {
  exitReasonLabel,
  formatDuration,
  formatNumber,
  formatSigned,
  Notification,
  NotificationLevel,
} from '../notification.types';

/** Subset of Discord's embed object we use (docs: resources/message#embed-object). */
export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  /** ISO8601. */
  timestamp?: string;
}

export interface DiscordWebhookPayload {
  username?: string;
  embeds: DiscordEmbed[];
  /** Always empty: a symbol, reason or error text can never ping @everyone or a role. */
  allowed_mentions: { parse: [] };
}

// Discord limits (per embed / per message).
const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, footer: 2048, total: 6000 };

const COLORS = {
  longOpen: 0x3498db,
  shortOpen: 0xe67e22,
  profit: 0x2ecc71,
  loss: 0xe74c3c,
  info: 0x95a5a6,
  warning: 0xf1c40f,
  critical: 0xe74c3c,
  recovery: 0x2ecc71,
  restart: 0x3498db,
  neutral: 0x3498db,
};

const OPS_ICONS = { incident: '🚨', recovery: '✅', restart: '🔄' } as const;

const LEVEL_TITLES: Record<NotificationLevel, string> = {
  info: 'ℹ️ Aviso do bot',
  warning: '⚠️ Atenção',
  critical: '🚨 Alerta crítico',
};

export function buildDiscordPayload(notification: Notification, username?: string): DiscordWebhookPayload {
  return {
    ...(username ? { username: truncate(username, 80) } : {}),
    embeds: [enforceLimits(buildEmbed(notification))],
    allowed_mentions: { parse: [] },
  };
}

function buildEmbed(notification: Notification): DiscordEmbed {
  if (notification.kind === 'ops') {
    const n = notification.notice;
    const icon = n.phase === 'incident' && n.severity === 'warning' ? '⚠️' : OPS_ICONS[n.phase];
    return {
      title: `${icon} KRYPTO — ${n.headline}`,
      description: n.summary,
      color: n.phase === 'recovery' ? COLORS.recovery : n.phase === 'restart' ? COLORS.restart : COLORS[n.severity],
      fields: n.fields.map(([name, value]) => field(name, value)),
      footer: { text: `incidente ${n.incidentKey}` },
      timestamp: n.at,
    };
  }

  if (notification.kind === 'report') {
    const r = notification.report;
    return {
      title: `${r.icon} KRYPTO — ${r.headline}`,
      description: r.summary,
      color: r.tone === 'profit' ? COLORS.profit : r.tone === 'loss' ? COLORS.loss : COLORS[r.tone],
      fields: r.fields.map(([name, value]) => field(name, value)),
      ...(r.footer ? { footer: { text: r.footer } } : {}),
      timestamp: r.at,
    };
  }

  if (notification.kind === 'alert') {
    return {
      title: LEVEL_TITLES[notification.level],
      description: notification.message,
      color: COLORS[notification.level],
      timestamp: new Date().toISOString(),
    };
  }

  if (notification.kind === 'trade.opened') {
    const t = notification.trade;
    const isShort = t.side === 'SHORT';
    return {
      title: `${isShort ? '🔻 SHORT' : '🔺 LONG'} aberto · ${t.symbol}`,
      description: t.signalReason,
      color: isShort ? COLORS.shortOpen : COLORS.longOpen,
      fields: [
        field('Lado', t.side),
        field('Modo', t.mode),
        field('Timeframe', t.timeframe ?? 'n/d'),
        field('Estratégia', t.strategy),
        field('Preço de entrada', formatNumber(t.entryPrice)),
        field('Quantidade', formatNumber(t.qty)),
        field('Notional', `${formatNumber(t.qty * t.entryPrice)} USDT`),
        field('Stop loss', formatNumber(t.stopLoss)),
        ...(t.takeProfit !== undefined ? [field('Take profit', formatNumber(t.takeProfit))] : []),
      ],
      footer: { text: `trade ${t.tradeId}` },
      timestamp: t.entryTime,
    };
  }

  const t = notification.trade;
  const won = t.pnl > 0;
  return {
    title: `${won ? '✅' : '❌'} ${t.side} fechado · ${t.symbol} · ${formatSigned(t.pnlPct)}%`,
    description: t.reasonDetail,
    color: won ? COLORS.profit : COLORS.loss,
    fields: [
      field('Lado', t.side),
      field('Modo', t.mode),
      field('Timeframe', t.timeframe ?? 'n/d'),
      field('Estratégia', t.strategy),
      field('Entrada', formatNumber(t.entryPrice)),
      field('Saída', formatNumber(t.exitPrice)),
      field('Quantidade', formatNumber(t.qty)),
      field('PnL', `${formatSigned(t.pnl)} USDT`),
      field('Resultado', `${formatSigned(t.pnlPct)}%`),
      field('Motivo', exitReasonLabel(t.reason)),
      field('Duração', formatDuration(t.entryTime, t.exitTime)),
      field('Taxas', `${formatNumber(t.fees)} USDT`),
    ],
    footer: { text: `trade ${t.tradeId} · aberto em ${t.entryTime}` },
    timestamp: t.exitTime,
  };
}

function field(name: string, value: string): { name: string; value: string; inline: boolean } {
  return { name, value: value || '—', inline: true };
}

/** Truncates every part to Discord's limits so a long reason can never get the message rejected (400). */
function enforceLimits(embed: DiscordEmbed): DiscordEmbed {
  const out: DiscordEmbed = {
    ...embed,
    title: truncate(embed.title, LIMITS.title),
    ...(embed.description ? { description: truncate(embed.description, LIMITS.description) } : {}),
    ...(embed.fields
      ? {
          fields: embed.fields.slice(0, LIMITS.fields).map((f) => ({
            ...f,
            name: truncate(f.name, LIMITS.fieldName),
            value: truncate(f.value, LIMITS.fieldValue),
          })),
        }
      : {}),
    ...(embed.footer ? { footer: { text: truncate(embed.footer.text, LIMITS.footer) } } : {}),
  };
  const size = embedSize(out);
  if (size > LIMITS.total && out.description) {
    out.description = truncate(out.description, Math.max(1, out.description.length - (size - LIMITS.total)));
  }
  return out;
}

function embedSize(embed: DiscordEmbed): number {
  return (
    embed.title.length +
    (embed.description?.length ?? 0) +
    (embed.footer?.text.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
