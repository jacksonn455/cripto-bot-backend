export interface PremiumIndexEntry {
  symbol: string;
  lastFundingRate: number;
  nextFundingTime: number;
  time: number;
}

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
}
