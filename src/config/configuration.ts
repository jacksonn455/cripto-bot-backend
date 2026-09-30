import { registerAs } from '@nestjs/config';

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
}));

export const binanceConfig = registerAs('binance', () => ({
  apiKey: process.env.BINANCE_API_KEY ?? '',
  apiSecret: process.env.BINANCE_API_SECRET ?? '',
  baseUrl: process.env.BINANCE_BASE_URL ?? 'https://testnet.binance.vision',
  wsBaseUrl: process.env.BINANCE_WS_BASE_URL ?? 'wss://testnet.binance.vision',
  recvWindow: parseInt(process.env.BINANCE_RECV_WINDOW ?? '5000', 10),
  // Where PAPER/backtest read prices from — independent of baseUrl (where real orders go).
  marketDataBaseUrl: process.env.MARKET_DATA_BASE_URL ?? 'https://api.binance.com',
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
}));

export const controlConfig = registerAs('control', () => ({
  // Required to call POST /bot/pause, /resume, /kill-switch — GET /bot/status stays open.
  apiKey: process.env.CONTROL_API_KEY ?? '',
  // true = every route except /health requires X-Control-Api-Key (publicly hosted backend).
  requireKeyForAllRoutes: process.env.API_KEY_REQUIRED_FOR_ALL === 'true',
}));

export const notificationsConfig = registerAs('notifications', () => ({
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
}));

export const fundingConfig = registerAs('funding', () => ({
  enabled: process.env.FUNDING_SCAN_ENABLED !== 'false',
  // Futures perpetuals public endpoint — always production, regardless of TRADING_MODE
  // (this module never places orders, so there's no testnet-safety reason to use testnet here).
  baseUrl: process.env.FUNDING_BASE_URL ?? 'https://fapi.binance.com',
}));

export const redisConfig = registerAs('redis', () => ({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // TTL for cached report/chart queries — short-lived, also actively invalidated on trade events.
  reportsTtlSeconds: parseInt(process.env.REPORTS_CACHE_TTL_SECONDS ?? '30', 10),
}));
