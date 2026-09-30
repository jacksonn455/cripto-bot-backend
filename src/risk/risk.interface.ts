import { SymbolFilters } from '../exchange/types/symbol-filters.type';

export interface SymbolLiquidity {
  volume24h: number;
  spreadPct: number;
}

export interface RiskContext {
  /** Account equity/balance to size the trade against. */
  accountEquity: number;
  openPositionsCount: number;
  /** Current notional exposure per symbol (e.g. { BTCUSDT: 500 }). */
  currentExposureByAsset: Record<string, number>;
  totalExposure: number;
  /** Realized + unrealized PnL for the current day (negative = loss). */
  dailyPnl: number;
  consecutiveStopLosses: number;
  isPaused: boolean;
  reconciliationOk: boolean;
  symbolLiquidity?: SymbolLiquidity;
  symbolFilters?: SymbolFilters;
  /**
   * Whether the venue can open short positions (sell an asset the account doesn't hold).
   * Binance Spot can't; the paper gateway and backtests simulate it. Absent = not supported.
   */
  shortSellingSupported?: boolean;
}

export type RejectReason =
  | 'BOT_PAUSED'
  | 'RECONCILIATION_FAILED'
  | 'SHORT_NOT_SUPPORTED'
  | 'DAILY_LOSS_LIMIT'
  | 'CONSECUTIVE_STOPS_LIMIT'
  | 'MAX_OPEN_POSITIONS'
  | 'MISSING_STOP_LOSS'
  | 'INVALID_STOP_DISTANCE'
  | 'INVALID_TAKE_PROFIT'
  | 'MAX_EXPOSURE_EXCEEDED'
  | 'RR_TOO_LOW'
  | 'LOW_LIQUIDITY'
  | 'SPREAD_TOO_WIDE'
  | 'LOT_SIZE_TOO_SMALL'
  | 'MIN_NOTIONAL_NOT_MET';

export interface RiskDecision {
  approved: boolean;
  rejectReason?: RejectReason;
  qty?: number;
}
