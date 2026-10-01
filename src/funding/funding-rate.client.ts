export interface PremiumIndexEntry {
  symbol: string;
  lastFundingRate: number;
  nextFundingTime: number;
  time: number;
}

export interface FundingHistoryEntry {
  symbol: string;
  fundingTime: number;
  fundingRate: number;
}

interface RawFundingHistoryEntry {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

/** Max rows per /fapi/v1/fundingRate page. */
const FUNDING_HISTORY_PAGE = 1000;

interface RawPremiumIndexEntry {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

/**
 * Public, read-only Binance USD-M Futures endpoint (no API key needed). @binance/connector
 * doesn't cover the Futures API, so this is a minimal direct client using Node's built-in fetch.
 */
export class FundingRateClient {
  constructor(private readonly baseUrl: string) {}

  async getPremiumIndex(): Promise<PremiumIndexEntry[]> {
    const response = await fetch(`${this.baseUrl}/fapi/v1/premiumIndex`);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Binance Futures API error (HTTP ${response.status}): ${body}`);
    }
    const data = (await response.json()) as RawPremiumIndexEntry[];
    return data.map((entry) => ({
      symbol: entry.symbol,
      lastFundingRate: parseFloat(entry.lastFundingRate),
      nextFundingTime: entry.nextFundingTime,
      time: entry.time,
    }));
  }

  /** Settled funding rates of one perpetual in [startTime, endTime] (epoch ms), oldest first, paginated. */
  async getFundingHistory(symbol: string, startTime: number, endTime: number): Promise<FundingHistoryEntry[]> {
    const rows: FundingHistoryEntry[] = [];
    let cursor = startTime;
    while (cursor <= endTime) {
      const url = `${this.baseUrl}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&startTime=${cursor}&endTime=${endTime}&limit=${FUNDING_HISTORY_PAGE}`;
      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Binance Futures API error (HTTP ${response.status}): ${body}`);
      }
      const page = (await response.json()) as RawFundingHistoryEntry[];
      rows.push(...page.map((r) => ({ symbol: r.symbol, fundingTime: r.fundingTime, fundingRate: parseFloat(r.fundingRate) })));
      if (page.length < FUNDING_HISTORY_PAGE) break;
      cursor = page[page.length - 1].fundingTime + 1;
    }
    return rows;
  }
}
