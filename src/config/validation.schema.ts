import * as Joi from 'joi';

// Fails fast on boot if required env vars are missing or LIVE mode is misconfigured.
export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(8000),
  HOST: Joi.string().ip().default('0.0.0.0'),
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),

  MONGO_URI: Joi.string()
    .uri({ scheme: ['mongodb', 'mongodb+srv'] })
    .default('mongodb://localhost:27017/trade-bot'),

  TRADING_MODE: Joi.string().valid('PAPER', 'LIVE').default('PAPER'),
  // Second gate for LIVE mode: env alone can never accidentally enable real orders.
  LIVE_TRADING_CONFIRMED: Joi.boolean().when('TRADING_MODE', {
    is: 'LIVE',
    then: Joi.boolean().valid(true).required().messages({
      'any.only':
        'LIVE_TRADING_CONFIRMED must be explicitly set to true when TRADING_MODE=LIVE',
      'any.required':
        'LIVE_TRADING_CONFIRMED is required when TRADING_MODE=LIVE',
    }),
    otherwise: Joi.boolean().default(false),
  }),

  BINANCE_API_KEY: Joi.string().when('TRADING_MODE', {
    is: 'LIVE',
    then: Joi.string().min(10).required(),
    otherwise: Joi.string().allow('').optional().default(''),
  }),
  BINANCE_API_SECRET: Joi.string().when('TRADING_MODE', {
    is: 'LIVE',
    then: Joi.string().min(10).required(),
    otherwise: Joi.string().allow('').optional().default(''),
  }),
  BINANCE_BASE_URL: Joi.string()
    .uri()
    .default('https://testnet.binance.vision'),
  BINANCE_WS_BASE_URL: Joi.string()
    .uri()
    .default('wss://testnet.binance.vision'),
  BINANCE_RECV_WINDOW: Joi.number().integer().min(1000).max(60000).default(5000),
  // Read-only price feed for PAPER mode/backtests, decoupled from where orders are routed —
  // defaults to real production data so simulated fills reflect real market prices.
  MARKET_DATA_BASE_URL: Joi.string().uri().default('https://api.binance.com'),

  PAPER_INITIAL_BALANCE_ASSET: Joi.string().default('USDT'),
  PAPER_INITIAL_BALANCE_AMOUNT: Joi.number().positive().default(10000),

  // --- TrendRegimeStrategy ---
  TREND_SYMBOLS: Joi.string().default('BTCUSDT,ETHUSDT'),
  TREND_TIMEFRAME: Joi.string().default('1h'),
  TREND_REGIME_TIMEFRAME: Joi.string().default('4h'),
  TREND_EMA_FAST: Joi.number().integer().positive().default(20),
  TREND_EMA_SLOW: Joi.number().integer().positive().default(50),
  TREND_EMA_REGIME: Joi.number().integer().positive().default(200),
  TREND_RSI_PERIOD: Joi.number().integer().positive().default(14),
  TREND_RSI_MIN: Joi.number().min(0).max(100).default(45),
  TREND_RSI_MAX: Joi.number().min(0).max(100).default(70),
  TREND_ATR_PERIOD: Joi.number().integer().positive().default(14),
  TREND_ATR_STOP_MULT: Joi.number().positive().default(2),
  TREND_CHANDELIER_LOOKBACK: Joi.number().integer().positive().default(22),
  TREND_CHANDELIER_ATR_MULT: Joi.number().positive().default(3),

  // --- RiskManager ---
  RISK_PER_TRADE_PCT: Joi.number().positive().max(1).default(0.01),
  RISK_MAX_OPEN_POSITIONS: Joi.number().integer().positive().default(3),
  RISK_MAX_EXPOSURE_PER_ASSET_PCT: Joi.number().positive().max(1).default(0.3),
  RISK_MAX_TOTAL_EXPOSURE_PCT: Joi.number().positive().max(1).default(0.6),
  RISK_MAX_DAILY_LOSS_PCT: Joi.number().positive().max(1).default(0.03),
  RISK_MAX_CONSECUTIVE_STOPS: Joi.number().integer().positive().default(3),
  RISK_MIN_RR_RATIO: Joi.number().positive().default(1.5),
  RISK_MIN_VOLUME_24H: Joi.number().min(0).default(0),
  RISK_MAX_SPREAD_PCT: Joi.number().positive().default(100),

  // --- ExecutionModule ---
  // Off by default even in PAPER mode — an extra explicit opt-in before the automated loop runs.
  EXECUTION_ENABLED: Joi.boolean().default(false),
  EXECUTION_POLL_INTERVAL_SECONDS: Joi.number().integer().positive().default(60),
  EXECUTION_RECONCILIATION_INTERVAL_MINUTES: Joi.number().integer().positive().default(15),
  EXECUTION_STOP_LIMIT_OFFSET_PCT: Joi.number().min(0).max(0.1).default(0.001),
  EQUITY_SNAPSHOT_INTERVAL_MINUTES: Joi.number().integer().positive().default(5),

  // --- ControlModule ---
  // true = reads need the key too (except /health). Use when the API is reachable from the internet.
  API_KEY_REQUIRED_FOR_ALL: Joi.boolean().default(false),
  CONTROL_API_KEY: Joi.string().when('API_KEY_REQUIRED_FOR_ALL', {
    is: true,
    then: Joi.string().min(32).required().messages({
      'any.required': 'CONTROL_API_KEY is required when API_KEY_REQUIRED_FOR_ALL=true',
    }),
    otherwise: Joi.string().allow('').optional().default(''),
  }),
  // false = no Swagger UI at /docs (recommended on a public host).
  SWAGGER_ENABLED: Joi.boolean().default(true),

  // --- Notifications (optional) ---
  TELEGRAM_BOT_TOKEN: Joi.string().allow('').optional().default(''),
  TELEGRAM_CHAT_ID: Joi.string().allow('').optional().default(''),

  // --- Funding scanner (read-only) ---
  FUNDING_SCAN_ENABLED: Joi.boolean().default(true),
  FUNDING_BASE_URL: Joi.string().uri().default('https://fapi.binance.com'),

  // --- Redis (reports/charts cache) ---
  // Empty string = cache disabled (e.g. a host without Redis); unset = local default.
  REDIS_URL: Joi.string().uri().allow('').default('redis://localhost:6379'),
  REPORTS_CACHE_TTL_SECONDS: Joi.number().integer().positive().default(30),
});
