import { buildDiscordPayload } from './discord/discord-embed.formatter';
import { categoryOf } from './notification.types';
import {
  backtestCompletedNotice,
  dailyReportNotice,
  signalVetoDigestNotice,
  type DailyReportData,
  type SignalRecordedEvent,
} from './report-notices';
import { formatTelegramText } from './telegram/telegram-notification.provider';

const clock = (d: Date) => d.toISOString();
const fieldsOf = (fields: Array<[string, string]>) => Object.fromEntries(fields);

function day(overrides: Partial<DailyReportData> = {}): DailyReportData {
  return {
    mode: 'PAPER',
    from: new Date('2026-09-30T11:00:00.000Z'),
    to: new Date('2026-10-01T11:00:00.000Z'),
    closedTrades: [
      { pnl: 30, pnlPct: 1.5 },
      { pnl: -10, pnlPct: -0.5 },
    ],
    totalFees: 2.5,
    openPositions: [{ symbol: 'BTCUSDT', side: 'LONG' }],
    equityNow: 10_200,
    equityStart: 10_000,
    evaluations: 48,
    signalsApproved: 2,
    signalsVetoed: 3,
    activeIncidents: [],
    paused: false,
    workerState: 'ONLINE',
    lastEvaluationAt: new Date('2026-10-01T10:59:59.999Z'),
    ...overrides,
  };
}

function veto(overrides: Partial<SignalRecordedEvent> = {}): SignalRecordedEvent {
  return {
    symbol: 'BTCUSDT',
    strategy: 'TrendRegimeStrategy',
    signal: 'BUY',
    price: 65_000,
    approved: false,
    rejectReason: 'MAX_OPEN_POSITIONS',
    mode: 'PAPER',
    candleTime: '2026-10-01T10:59:59.999Z',
    ...overrides,
  };
}

describe('dailyReportNotice', () => {
  it('summarizes PnL, win rate, equity change and worker liveness', () => {
    const n = dailyReportNotice(day(), clock);
    const f = fieldsOf(n.fields);

    expect(n.category).toBe('reports');
    expect(n.summary).toContain('Estou vivo: 48 avaliação(ões)');
    expect(n.summary).toContain('2 trade(s) fechado(s), PnL +20.00 USDT');
    expect(n.tone).toBe('profit');
    expect(f['Win rate']).toBe('50% (1/2)');
    expect(f['Equity']).toBe('10200 USDT (+2.00% em 24h)');
    expect(f['Posições abertas']).toBe('BTCUSDT LONG');
    expect(f['Sinais']).toBe('2 aprovado(s) · 3 vetado(s)');
    expect(f['Incidentes ativos']).toBe('nenhum');
  });

  it('is a warning when the worker is not online, the bot is paused or nothing was evaluated', () => {
    expect(dailyReportNotice(day({ workerState: 'OFFLINE' }), clock).tone).toBe('warning');
    expect(dailyReportNotice(day({ paused: true, pauseReason: 'DAILY_LOSS_LIMIT' }), clock).tone).toBe('warning');
    const idle = dailyReportNotice(day({ evaluations: 0, closedTrades: [] }), clock);
    expect(idle.tone).toBe('warning');
    expect(idle.summary).toContain('nenhuma avaliação nas últimas 24h');
    expect(dailyReportNotice(day({ activeIncidents: ['REDIS'] }), clock).tone).toBe('warning');
  });

  it('handles a quiet day without equity snapshots', () => {
    const n = dailyReportNotice(day({ closedTrades: [], equityNow: null, equityStart: null, openPositions: [] }), clock);
    const f = fieldsOf(n.fields);
    expect(n.tone).toBe('neutral');
    expect(n.summary).toContain('Nenhum trade fechado.');
    expect(f['Win rate']).toBe('—');
    expect(f['Equity']).toBe('n/d');
    expect(f['Posições abertas']).toBe('nenhuma');
  });
});

describe('backtestCompletedNotice', () => {
  it('lists the headline metrics', () => {
    const n = backtestCompletedNotice({
      runId: 'run-1',
      strategy: 'TrendRegimeStrategy',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      timeframe: '1h',
      tradeCount: 40,
      totalPnl: 500,
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-12-31T00:00:00.000Z',
      initialBalance: 10_000,
      winRate: 0.45,
      profitFactor: 1.6,
      maxDrawdownPct: 0.082,
      sharpe: 1.234,
      totalFees: 12,
    });
    const f = fieldsOf(n.fields);
    expect(n.tone).toBe('profit');
    expect(f['PnL']).toBe('+500.00 USDT (+5.00%)');
    expect(f['Período']).toBe('2025-01-01 → 2025-12-31');
    expect(f['Win rate']).toBe('45.0%');
    expect(f['Max drawdown']).toBe('8.2%');
    expect(f['Sharpe']).toBe('1.23');
    expect(n.footer).toBe('run run-1');
  });

  it('tolerates an event without the metric fields', () => {
    const n = backtestCompletedNotice({ runId: 'r', strategy: 'S', symbols: ['BTCUSDT'], timeframe: '1h', tradeCount: 0, totalPnl: 0 });
    expect(n.tone).toBe('neutral');
    expect(fieldsOf(n.fields)['Win rate']).toBeUndefined();
  });
});

describe('signalVetoDigestNotice', () => {
  it('groups vetoes by reason, most frequent first', () => {
    const vetoes = [veto(), veto({ symbol: 'ETHUSDT', rejectReason: 'MIN_RR_RATIO' }), veto()];
    const n = signalVetoDigestNotice(vetoes, new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T11:00:00Z'), clock);
    expect(n.category).toBe('signals');
    expect(n.headline).toBe('3 sinais vetados pelo risco');
    expect(n.fields.slice(0, 2)).toEqual([
      ['MAX_OPEN_POSITIONS', '2'],
      ['MIN_RR_RATIO', '1'],
    ]);
    expect(n.summary).toContain('• ETHUSDT BUY @ 65000 — MIN_RR_RATIO');
  });

  it('caps the listed signals and says how many were left out', () => {
    const vetoes = Array.from({ length: 20 }, () => veto());
    const n = signalVetoDigestNotice(vetoes, new Date(), new Date(), clock);
    expect(n.summary.split('\n')).toHaveLength(16);
    expect(n.summary).toContain('… e mais 5 anterior(es)');
  });
});

describe('report notifications on the channels', () => {
  const report = { kind: 'report' as const, report: dailyReportNotice(day(), clock) };

  it('routes by the notice category', () => {
    expect(categoryOf(report)).toBe('reports');
  });

  it('renders as a Discord embed and as Telegram text', () => {
    const embed = buildDiscordPayload(report).embeds[0];
    expect(embed.title).toBe('📊 KRYPTO — Resumo diário');
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.fields?.find((f) => f.name === 'PnL realizado')?.value).toBe('+20.00 USDT');
    expect(formatTelegramText(report)).toMatch(/^KRYPTO — Resumo diário\n/);
  });
});
