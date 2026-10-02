import { registerAs } from '@nestjs/config';
import type { JudgeKind, JudgeMode } from '../candidates/judge/candidate-judge.interface';

export const appConfig = registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '8000', 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
}));

export const mongoConfig = registerAs('mongo', () => ({
  uri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/trade-bot',
}));

export type TradingMode = 'PAPER' | 'LIVE';

export const tradingConfig = registerAs('trading', () => ({
  mode: (process.env.TRADING_MODE ?? 'PAPER') as TradingMode,
  liveTradingConfirmed: process.env.LIVE_TRADING_CONFIRMED === 'true',
  paperInitialBalanceAsset: process.env.PAPER_INITIAL_BALANCE_ASSET ?? 'USDT',
  paperInitialBalanceAmount: parseFloat(
    process.env.PAPER_INITIAL_BALANCE_AMOUNT ?? '10000',
  ),
  // PAPER mirrors the LIVE venue (Binance Spot can't short): shorts are vetoed with
  // SHORT_NOT_SUPPORTED in both. true = PAPER simulates shorts anyway (a research setting: those
  // trades could never happen in LIVE). Backtests always can short; that is the allowShort knob.
  paperSimulatedShorts: process.env.PAPER_SIMULATED_SHORTS === 'true',
}));

export const binanceConfig = registerAs('binance', () => ({
  apiKey: process.env.BINANCE_API_KEY ?? '',
  apiSecret: process.env.BINANCE_API_SECRET ?? '',
  baseUrl: process.env.BINANCE_BASE_URL ?? 'https://testnet.binance.vision',
  wsBaseUrl: process.env.BINANCE_WS_BASE_URL ?? 'wss://testnet.binance.vision',
  recvWindow: parseInt(process.env.BINANCE_RECV_WINDOW ?? '5000', 10),
  // Where PAPER/backtest read prices from — independent of baseUrl (where real orders go).
  marketDataBaseUrl: process.env.MARKET_DATA_BASE_URL ?? 'https://api.binance.com',
  // Per HTTP request. The SDK's default is 0 = no timeout: one hung request froze a symbol's cycle forever.
  httpTimeoutMs: parseInt(process.env.BINANCE_HTTP_TIMEOUT_MS ?? '15000', 10),
}));

export const trendRegimeConfig = registerAs('trendRegime', () => ({
  symbols: (process.env.TREND_SYMBOLS ?? 'BTCUSDT,ETHUSDT').split(',').map((s) => s.trim()),
  timeframe: process.env.TREND_TIMEFRAME ?? '1h',
  regimeTimeframe: process.env.TREND_REGIME_TIMEFRAME ?? '4h',
  emaFast: parseInt(process.env.TREND_EMA_FAST ?? '20', 10),
  emaSlow: parseInt(process.env.TREND_EMA_SLOW ?? '50', 10),
  emaRegime: parseInt(process.env.TREND_EMA_REGIME ?? '200', 10),
  rsiPeriod: parseInt(process.env.TREND_RSI_PERIOD ?? '14', 10),
  rsiMin: parseFloat(process.env.TREND_RSI_MIN ?? '45'),
  rsiMax: parseFloat(process.env.TREND_RSI_MAX ?? '70'),
  atrPeriod: parseInt(process.env.TREND_ATR_PERIOD ?? '14', 10),
  atrStopMultiplier: parseFloat(process.env.TREND_ATR_STOP_MULT ?? '2'),
  // Chandelier exit lookback (candles) and ATR multiplier for the trailing stop.
  chandelierLookback: parseInt(process.env.TREND_CHANDELIER_LOOKBACK ?? '22', 10),
  chandelierAtrMultiplier: parseFloat(process.env.TREND_CHANDELIER_ATR_MULT ?? '3'),
  // 1 = the strategy also emits ENTER_SHORT (mirror of the long rules). A number, not a boolean,
  // so backtests can override it through strategyParams like any other knob. Off by default.
  allowShort: process.env.TREND_ALLOW_SHORT === 'true' ? 1 : 0,
  // ADX(adxPeriod) on the regime timeframe must be >= adxMin to enter. 0 = filter off (default).
  adxPeriod: parseInt(process.env.TREND_ADX_PERIOD ?? '14', 10),
  adxMin: parseFloat(process.env.TREND_ADX_MIN ?? '0'),
  // Regime only counts as up/down beyond EMA × (1 ± band), so it doesn't flip on every touch of the
  // EMA. Fraction (0.01 = 1%); 0 = plain close vs EMA (default).
  regimeBandPct: parseFloat(process.env.TREND_REGIME_BAND_PCT ?? '0'),
  // Research variants (docs/ESTRATEGIA-PESQUISA.md section 5), backtest only: deliberately NOT read
  // from env, so paper/live keep the validated behavior until a variant passes the protocol.
  // 1 = trailing stop since entry, checked inside the candle (V1); 0 = rolling chandelier on close.
  trailingMode: 0,
  // N > 0 = also enter on a pullback to EMA fast within the last N candles (V3); 0 = off.
  pullbackLookback: 0,
}));

export const riskConfig = registerAs('risk', () => ({
  riskPerTradePct: parseFloat(process.env.RISK_PER_TRADE_PCT ?? '0.01'),
  maxOpenPositions: parseInt(process.env.RISK_MAX_OPEN_POSITIONS ?? '3', 10),
  maxExposurePerAssetPct: parseFloat(process.env.RISK_MAX_EXPOSURE_PER_ASSET_PCT ?? '0.3'),
  maxTotalExposurePct: parseFloat(process.env.RISK_MAX_TOTAL_EXPOSURE_PCT ?? '0.6'),
  maxDailyLossPct: parseFloat(process.env.RISK_MAX_DAILY_LOSS_PCT ?? '0.03'),
  maxConsecutiveStops: parseInt(process.env.RISK_MAX_CONSECUTIVE_STOPS ?? '3', 10),
  minRiskRewardRatio: parseFloat(process.env.RISK_MIN_RR_RATIO ?? '1.5'),
  minVolume24h: parseFloat(process.env.RISK_MIN_VOLUME_24H ?? '0'),
  maxSpreadPct: parseFloat(process.env.RISK_MAX_SPREAD_PCT ?? '100'),
}));

export const executionConfig = registerAs('execution', () => ({
  enabled: process.env.EXECUTION_ENABLED === 'true',
  pollIntervalSeconds: parseInt(process.env.EXECUTION_POLL_INTERVAL_SECONDS ?? '60', 10),
  reconciliationIntervalMinutes: parseInt(
    process.env.EXECUTION_RECONCILIATION_INTERVAL_MINUTES ?? '15',
    10,
  ),
  // Limit price offset applied below the stop trigger for STOP_LOSS_LIMIT sell orders,
  // so the order actually fills once triggered instead of resting unfilled.
  stopLimitOffsetPct: parseFloat(process.env.EXECUTION_STOP_LIMIT_OFFSET_PCT ?? '0.001'),
  // How often PAPER/LIVE equity (cash + open positions at last price) is written to equity_snapshots.
  equitySnapshotIntervalMinutes: parseInt(process.env.EQUITY_SNAPSHOT_INTERVAL_MINUTES ?? '5', 10),
  // No persisted worker heartbeat for this long = worker OFFLINE (also the loop-stall threshold).
  workerHeartbeatTimeoutSeconds: parseInt(process.env.WORKER_HEARTBEAT_TIMEOUT_SECONDS ?? '300', 10),
  // A start after a heartbeat gap longer than this is reported as a recovery (event + alert);
  // shorter gaps are ordinary deploys/restarts.
  workerDowntimeAlertMinutes: parseInt(process.env.WORKER_DOWNTIME_ALERT_MINUTES ?? '10', 10),
  // Upper bound for one symbol's cycle, so a stuck symbol can't hold back the others.
  symbolCycleTimeoutSeconds: parseInt(process.env.EXECUTION_SYMBOL_TIMEOUT_SECONDS ?? '120', 10),
}));

export const controlConfig = registerAs('control', () => ({
  // Required to call POST /bot/pause, /resume, /kill-switch — GET /bot/status stays open.
  apiKey: process.env.CONTROL_API_KEY ?? '',
  // true = every route except /health requires X-Control-Api-Key (publicly hosted backend).
  requireKeyForAllRoutes: process.env.API_KEY_REQUIRED_FOR_ALL === 'true',
}));

/** Which domain events a channel receives: `alerts` (critical/pause/resume) and/or `trades` (open/close). */
/** alerts = incidents/pauses, trades = open/close, reports = daily report + backtests, signals = risk vetoes. */
export type NotificationCategory = 'alerts' | 'trades' | 'reports' | 'signals';
const NOTIFICATION_CATEGORIES: readonly string[] = ['alerts', 'trades', 'reports', 'signals'];

function parseCategories(raw: string | undefined, fallback: string): NotificationCategory[] {
  return (raw ?? fallback)
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c): c is NotificationCategory => NOTIFICATION_CATEGORIES.includes(c));
}

export const notificationsConfig = registerAs('notifications', () => ({
  // Telegram keeps its original behavior: on as soon as token + chat id exist, alerts only.
  telegramEnabled: process.env.TELEGRAM_ENABLED !== 'false',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  telegramEvents: parseCategories(process.env.TELEGRAM_EVENTS, 'alerts'),
  discordEnabled: process.env.DISCORD_ENABLED === 'true',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
  discordUsername: process.env.DISCORD_USERNAME ?? 'Trade Bot',
  discordEvents: parseCategories(process.env.DISCORD_EVENTS, 'alerts,trades,reports,signals'),
  // Per HTTP attempt; a slow chat API can never hold a trade cycle (delivery is fire-and-forget anyway).
  timeoutMs: parseInt(process.env.NOTIFICATIONS_TIMEOUT_MS ?? '5000', 10),
  // Clock times inside alert messages (worker offline/recovered) are written in this zone.
  timeZone: process.env.NOTIFICATIONS_TIME_ZONE ?? 'America/Sao_Paulo',
  // Operational incidents/recoveries on the same Discord webhook. Off = trades keep flowing,
  // incident notices are only logged. DISCORD_ENABLED=false still silences Discord entirely.
  discordAlertsEnabled: process.env.DISCORD_ALERTS_ENABLED !== 'false',
  // Anti-flap: a component that recovers and fails again within this window opens a new incident
  // (tracked and logged) without a second Discord message.
  alertCooldownSeconds: parseInt(process.env.DISCORD_ALERT_COOLDOWN_SECONDS ?? '300', 10),
  // Consecutive failed checks (≈ poll ticks) before a recoverable error becomes an incident.
  incidentFailureThreshold: parseInt(process.env.INCIDENT_FAILURE_THRESHOLD ?? '3', 10),
  // Shown as "Ambiente" in incident notices (defaults to NODE_ENV).
  environment: (process.env.KRYPTO_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development').toUpperCase(),
  // Daily report (PnL, trades, equity, worker liveness) at this hour of NOTIFICATIONS_TIME_ZONE.
  dailyReportEnabled: process.env.DAILY_REPORT_ENABLED !== 'false',
  dailyReportHour: parseInt(process.env.DAILY_REPORT_HOUR ?? '8', 10),
  // Risk-vetoed entry signals are grouped into one message per window (0 = one message per veto).
  signalVetoDigestMinutes: parseInt(process.env.SIGNAL_VETO_DIGEST_MINUTES ?? '60', 10),
}));

export const fundingConfig = registerAs('funding', () => ({
  enabled: process.env.FUNDING_SCAN_ENABLED !== 'false',
  // Futures perpetuals public endpoint — always production, regardless of TRADING_MODE
  // (this module never places orders, so there's no testnet-safety reason to use testnet here).
  baseUrl: process.env.FUNDING_BASE_URL ?? 'https://fapi.binance.com',
}));

export const redisConfig = registerAs('redis', () => ({
  // false = cache off even with a REDIS_URL (same effect as REDIS_URL=): reports read Mongo directly.
  enabled: process.env.REDIS_ENABLED !== 'false',
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  connectTimeoutMs: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS ?? '2000', 10),
  // A hung Redis costs a request at most this long before falling back to Mongo.
  commandTimeoutMs: parseInt(process.env.REDIS_COMMAND_TIMEOUT_MS ?? '500', 10),
  // Reconnect budget (exponential backoff up to 30s) before giving up; then one re-probe every 5 min.
  maxReconnectAttempts: parseInt(process.env.REDIS_MAX_RECONNECT_ATTEMPTS ?? '10', 10),
  // TTL for cached report/chart queries — short-lived, also actively invalidated on trade events.
  reportsTtlSeconds: parseInt(process.env.REPORTS_CACHE_TTL_SECONDS ?? '30', 10),
}));

export const openAiConfig = registerAs('openai', () => ({
  // Analysis/explanation layer only: agents get read-only tools and can never place or close orders.
  agentsEnabled: process.env.OPENAI_AGENTS_ENABLED === 'true',
  apiKey: process.env.OPENAI_API_KEY ?? '',
  // Empty = the Agents SDK default model.
  model: process.env.OPENAI_MODEL ?? '',
  // Per HTTP request to OpenAI (the openai client retries 429/5xx up to maxRetries on its own).
  requestTimeoutMs: parseInt(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? '30000', 10),
  maxRetries: parseInt(process.env.OPENAI_MAX_RETRIES ?? '2', 10),
  // Whole agent run (all model calls + tool calls), enforced with an AbortSignal.
  agentTimeoutMs: parseInt(process.env.OPENAI_AGENT_TIMEOUT_MS ?? '90000', 10),
  maxTurns: parseInt(process.env.OPENAI_AGENT_MAX_TURNS ?? '8', 10),
  maxConcurrentRuns: parseInt(process.env.OPENAI_MAX_CONCURRENT_RUNS ?? '2', 10),
  // Off by default: traces would send prompts and tool outputs (trades, balances) to OpenAI's dashboard.
  tracingEnabled: process.env.OPENAI_TRACING_ENABLED === 'true',
}));

export const candidatesConfig = registerAs('candidates', () => ({
  // Candidate ledger (candidate_assessments): every triggered entry setup, accepted or rejected, with
  // its gates, features and risk/pause outcome. Observability only — trading never reads it.
  ledgerEnabled: process.env.CANDIDATE_LEDGER_ENABLED !== 'false',
  // How often the worker fills in shadow outcomes (what a candidate would have done if traded).
  // 0 = never automatically (POST /candidates/shadow/refresh still works).
  shadowRefreshMinutes: parseInt(process.env.CANDIDATE_SHADOW_REFRESH_MINUTES ?? '60', 10),
  // off = no judge runs (default). shadow = the judge's assessment is stored on each candidate and
  // NEVER read for trading. There is no mode in which a judge can change a decision yet.
  judgeMode: (process.env.AI_JUDGE_MODE ?? 'off') as JudgeMode,
  // Which judge runs in shadow mode: noop (no opinion) or baseline (the deterministic rules). No LLM.
  judge: (process.env.AI_JUDGE ?? 'noop') as JudgeKind,
  // Per assessment; a slow judge only loses its own assessment, never delays a decision (it runs after it).
  judgeTimeoutMs: parseInt(process.env.AI_JUDGE_TIMEOUT_MS ?? '5000', 10),
}));
