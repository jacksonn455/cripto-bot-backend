// Trading rules enforced by Binance for a symbol; used to round qty/price before every order.
export interface SymbolFilters {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  /** LOT_SIZE */
  minQty: number;
  maxQty: number;
  stepSize: number;
  /** PRICE_FILTER */
  minPrice: number;
  maxPrice: number;
  tickSize: number;
  /** MIN_NOTIONAL / NOTIONAL */
  minNotional: number;
}
