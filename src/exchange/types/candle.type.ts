export interface Candle {
  symbol: string;
  interval: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  /** False for the currently-forming candle; strategies must never act on those. */
  isClosed: boolean;
}

export interface GetCandlesParams {
  symbol: string;
  interval: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}
