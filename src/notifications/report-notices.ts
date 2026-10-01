import { formatNumber, formatSigned, type ReportNotice } from './notification.types';

/** Payload of `backtest.completed` (BacktestService). The metric fields are absent on older emitters. */
export interface BacktestCompletedEvent {
  runId: string;
  strategy: string;
  symbols: string[];
  timeframe: string;
  tradeCount: number;
  totalPnl: number;
  from?: string;
  to?: string;
  initialBalance?: number;
  /** Fractions (0.55 = 55%). */
  winRate?: number;
  maxDrawdownPct?: number;
  profitFactor?: number;
  sharpe?: number;
  totalFees?: number;
}

/** Payload of `signal.recorded` (SignalsService), one per entry signal evaluated by risk. */
export interface SignalRecordedEvent {
  symbol: string;
  strategy: string;
  signal: string;
  reason?: string;
  price?: number;
  approved: boolean;
  rejectReason: string | null;
  mode: string;
  candleTime: string;
}

/** Everything the daily report shows, gathered by DailyReportService. */
export interface DailyReportData {
  mode: string;
  from: Date;
  to: Date;
  closedTrades: Array<{ pnl: number; pnlPct: number }>;
  totalFees: number;
  openPositions: Array<{ symbol: string; side: string }>;
  /** Latest equity snapshot, and the first one inside the window (for the 24h change). */
  equityNow: number | null;
  equityStart: number | null;
  evaluations: number;
  signalsApproved: number;
  signalsVetoed: number;
  /** Keys of incidents still open right now (IncidentService keeps them in memory). */
  activeIncidents: string[];
  paused: boolean;
  pauseReason?: string;
  workerState: string;
  lastEvaluationAt: Date | null;
}

type Clock = (d: Date) => string;

const pct = (fraction: number, decimals = 1) => `${(fraction * 100).toFixed(decimals)}%`;
const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export function backtestCompletedNotice(e: BacktestCompletedEvent, at = new Date()): ReportNotice {
  const pnlPct = finite(e.initialBalance) && e.initialBalance > 0 ? ` (${formatSigned((e.totalPnl / e.initialBalance) * 100)}%)` : '';
  const fields: Array<[string, string]> = [
    ['Estratégia', e.strategy],
    ['Símbolos', e.symbols.join(', ') || 'n/d'],
    ['Timeframe', e.timeframe],
    ...(e.from && e.to ? ([['Período', `${e.from.slice(0, 10)} → ${e.to.slice(0, 10)}`]] as Array<[string, string]>) : []),
    ['Trades', String(e.tradeCount)],
    ['PnL', `${formatSigned(e.totalPnl)} USDT${pnlPct}`],
  ];
  if (finite(e.winRate)) fields.push(['Win rate', pct(e.winRate)]);
  if (finite(e.profitFactor)) fields.push(['Profit factor', e.profitFactor.toFixed(2)]);
  if (finite(e.maxDrawdownPct)) fields.push(['Max drawdown', pct(e.maxDrawdownPct)]);
  if (finite(e.sharpe)) fields.push(['Sharpe', e.sharpe.toFixed(2)]);
  if (finite(e.totalFees)) fields.push(['Taxas', `${formatNumber(e.totalFees)} USDT`]);
  return {
    category: 'reports',
    icon: '🧪',
    headline: 'Backtest concluído',
    summary: `${e.strategy} em ${e.symbols.join(', ')}: ${e.tradeCount} trade(s), PnL ${formatSigned(e.totalPnl)} USDT.`,
    tone: e.tradeCount === 0 ? 'neutral' : e.totalPnl > 0 ? 'profit' : 'loss',
    fields,
    footer: `run ${e.runId}`,
    at: at.toISOString(),
  };
}

const MAX_VETO_LINES = 15;

/** One message for every risk veto in the window: counts per reason plus the latest signals. */
export function signalVetoDigestNotice(vetoes: SignalRecordedEvent[], from: Date, to: Date, clock: Clock): ReportNotice {
  const byReason = new Map<string, number>();
  for (const v of vetoes) {
    const reason = v.rejectReason ?? 'n/d';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const latest = vetoes.slice(-MAX_VETO_LINES);
  const lines = latest.map(
    (v) => `• ${v.symbol} ${v.signal}${finite(v.price) ? ` @ ${formatNumber(v.price)}` : ''} — ${v.rejectReason ?? 'n/d'}`,
  );
  if (vetoes.length > latest.length) lines.unshift(`… e mais ${vetoes.length - latest.length} anterior(es)`);
  return {
    category: 'signals',
    icon: '🛡️',
    headline: vetoes.length === 1 ? 'Sinal vetado pelo risco' : `${vetoes.length} sinais vetados pelo risco`,
    summary: lines.join('\n'),
    tone: 'warning',
    fields: [
      ...[...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]): [string, string] => [reason, String(n)]),
      ['Período', `${clock(from)} → ${clock(to)}`],
    ],
    at: to.toISOString(),
  };
}

export function dailyReportNotice(d: DailyReportData, clock: Clock): ReportNotice {
  const trades = d.closedTrades;
  const pnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0).length;
  const equityChange =
    d.equityNow !== null && d.equityStart !== null && d.equityStart !== 0
      ? ` (${formatSigned(((d.equityNow - d.equityStart) / d.equityStart) * 100)}% em 24h)`
      : '';
  const online = d.workerState === 'ONLINE';

  const fields: Array<[string, string]> = [
    ['Modo', d.mode],
    ['Worker', d.workerState],
    ['Bot', d.paused ? `PAUSADO (${d.pauseReason ?? 'n/d'})` : 'ATIVO'],
    ['Trades fechados', String(trades.length)],
    ['PnL realizado', `${formatSigned(pnl)} USDT`],
    ['Win rate', trades.length ? `${pct(wins / trades.length, 0)} (${wins}/${trades.length})` : '—'],
    ['Taxas', `${formatNumber(d.totalFees)} USDT`],
    ['Equity', d.equityNow !== null ? `${formatNumber(d.equityNow)} USDT${equityChange}` : 'n/d'],
    [
      'Posições abertas',
      d.openPositions.length ? d.openPositions.map((p) => `${p.symbol} ${p.side}`).join(', ') : 'nenhuma',
    ],
    ['Avaliações (candles)', String(d.evaluations)],
    ['Sinais', `${d.signalsApproved} aprovado(s) · ${d.signalsVetoed} vetado(s)`],
    ['Incidentes ativos', d.activeIncidents.length ? d.activeIncidents.join(', ') : 'nenhum'],
    ['Última avaliação', d.lastEvaluationAt ? clock(d.lastEvaluationAt) : 'n/d'],
  ];

  const health = online
    ? d.evaluations > 0
      ? `Estou vivo: ${d.evaluations} avaliação(ões) nas últimas 24h.`
      : 'Worker online, mas nenhuma avaliação nas últimas 24h.'
    : `Worker ${d.workerState}.`;
  const result = trades.length
    ? `${trades.length} trade(s) fechado(s), PnL ${formatSigned(pnl)} USDT.`
    : 'Nenhum trade fechado.';

  return {
    category: 'reports',
    icon: '📊',
    headline: 'Resumo diário',
    summary: `${health} ${result}`,
    tone: !online || d.paused || d.evaluations === 0 || d.activeIncidents.length > 0 ? 'warning' : trades.length === 0 ? 'neutral' : pnl > 0 ? 'profit' : 'loss',
    fields,
    footer: `${clock(d.from)} → ${clock(d.to)}`,
    at: d.to.toISOString(),
  };
}
