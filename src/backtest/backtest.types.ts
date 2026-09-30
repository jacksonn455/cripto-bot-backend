import type { TradeExitReason, TradeSide } from '../trades/schemas/trade.schema';

export interface BacktestParams {
  strategy: string;
  symbol: string;
  initialBalance: number;
  /** Fraction, e.g. 0.001 = 0.1% per side. */
  feesPct: number;
  /** Fraction applied unfavorably to entry/exit fills. */
  slippagePct: number;
  /**
   * Carry cost of holding a short, as a fraction of the entry notional per day held (borrow
   * interest on margin, or average funding paid on perpetuals). Charged as a fee at exit.
   * 0/omitted = not modeled.
   */
  shortBorrowPctPerDay?: number;
  symbolFilters?: {
    stepSize: number;
    minQty: number;
    minNotional: number;
  };
  /**
   * How many candles (ending at the current one) the strategy sees per step — the same number the
   * live loop fetches. Omitted = the whole history so far.
   */
  candleLookback?: number;
  /**
   * Epoch ms. Candles closing before this are warm-up only: they feed indicators but are never
   * traded or recorded, like the history the live loop already has when it starts.
   */
  tradeFrom?: number;
}

export interface SimulatedTrade {
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  entryTime: number;
  exitTime: number;
  /** Exchange fees plus, for shorts, the modeled carry cost. Already subtracted from pnl. */
  fees: number;
  /** Part of `fees` that is short carry cost (0 for longs). */
  carryCost: number;
  /** Quote amount lost to slippage on entry + exit (already reflected in the fill prices). */
  slippageCost: number;
  pnl: number;
  pnlPct: number;
  stopLoss: number;
  takeProfit?: number;
  exitReason: TradeExitReason;
  maxAdverseExcursion: number;
  maxFavorableExcursion: number;
}

export interface EquityPoint {
  timestamp: number;
  balance: number;
  equity: number;
  openPositions: number;
}

export interface RejectedSignalRecord {
  candleTime: number;
  symbol: string;
  approved: boolean;
  rejectReason?: string;
  indicators: Record<string, number | undefined>;
  action: string;
}

export interface BacktestResult {
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  signals: RejectedSignalRecord[];
  finalBalance: number;
}
