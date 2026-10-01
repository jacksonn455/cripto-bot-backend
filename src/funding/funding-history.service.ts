import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { fundingConfig } from '../config/configuration';
import { FundingRateClient } from './funding-rate.client';
import { FundingHistory, FundingHistoryDocument } from './schemas/funding-history.schema';

const FUNDING_INTERVAL_MS = 8 * 3_600_000;
/** Below this share of the expected settlements, the cache is refreshed from Binance. */
const MIN_COVERAGE = 0.95;

/** Read-only: historical funding for backtests, cached in `funding_history`. Never places orders. */
@Injectable()
export class FundingHistoryService {
  private readonly client: FundingRateClient;

  constructor(
    @InjectModel(FundingHistory.name) private readonly model: Model<FundingHistoryDocument>,
    @Inject(fundingConfig.KEY) config: ReturnType<typeof fundingConfig>,
  ) {
    this.client = new FundingRateClient(config.baseUrl);
  }

  /**
   * Funding settlements of `symbol`'s perpetual in [fromMs, toMs], oldest first. Throws when
   * Binance can't be reached or has no such perpetual — the caller decides the fallback.
   * A perpetual listed after `fromMs` never reaches full coverage, so it's re-fetched each time
   * (correct, just slower).
   */
  async getRange(symbol: string, fromMs: number, toMs: number): Promise<Array<{ time: number; rate: number }>> {
    const query = { symbol: symbol.toUpperCase(), fundingTime: { $gte: new Date(fromMs), $lte: new Date(toMs) } };
    const cached = await this.model.find(query).sort({ fundingTime: 1 }).lean();
    const expected = Math.floor((toMs - fromMs) / FUNDING_INTERVAL_MS);
    if (cached.length > 0 && cached.length >= expected * MIN_COVERAGE) {
      return cached.map((r) => ({ time: r.fundingTime.getTime(), rate: r.rate }));
    }

    const fetched = await this.client.getFundingHistory(symbol.toUpperCase(), fromMs, toMs);
    if (fetched.length) {
      await this.model.bulkWrite(
        fetched.map((r) => ({
          updateOne: {
            filter: { symbol: r.symbol, fundingTime: new Date(r.fundingTime) },
            update: { $set: { rate: r.fundingRate } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    return fetched.map((r) => ({ time: r.fundingTime, rate: r.fundingRate }));
  }
}
