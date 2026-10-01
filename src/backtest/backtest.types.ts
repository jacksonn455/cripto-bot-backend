import type { Candle } from '../exchange/types/candle.type';
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
   * Slippage for stop-loss exits (stop-market orders fill worse than planned entries, especially in
   * fast markets). Omitted = slippagePct.
   */
  stopSlippagePct?: number;
  /**
   * Portfolio-level cap on the summed initial risk of open positions on the same side (fraction of
   * the cash balance). Only binds when several symbols share one balance (runPortfolio).
   */
  maxSameSideRiskPct?: number;
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
   * Regime candles the strategy sees per step. Omitted = candleLookback, like the live loop (which
   * makes a 200-period EMA little more than an SMA). Research variant V1 uses more for a real EMA.
   */
  regimeLookback?: number;
  /**
   * Epoch ms. Candles closing before this are warm-up only: they feed indicators but are never
   * traded or recorded, like the history the live loop already has when it starts.
   */
  tradeFrom?: number;
}

/** One funding settlement of a perpetual (fraction of the notional; positive = longs pay shorts). */
export interface FundingEvent {
  time: number;
  rate: number;
}

/** One symbol's market data for a (possibly multi-symbol) simulation. */
export interface SymbolSeries {
  symbol: string;
  candles: Candle[];
  /** Higher-timeframe candles for the regime filter; only the ones closed by each step are visible. */
  regimeCandles?: Candle[];
  symbolFilters?: BacktestParams['symbolFilters'];
  /**
   * Real funding history, sorted by time. When present, a short's carry is the funding it would have
   * paid (or received) at each settlement it was open for, instead of shortBorrowPctPerDay.
   */
  fundingEvents?: FundingEvent[];
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
  /** Extra loss from a stop filled at the open of a candle that gapped through it (0 otherwise). */
  gapCost: number;
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
  /** Times the consecutive-stops pause was lifted at the next UTC day (see BacktestRunner). */
  stopPauses: number;
}
