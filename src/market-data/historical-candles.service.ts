import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { binanceConfig } from '../config/configuration';
import { BinanceRestClient } from '../exchange/binance/binance-rest.client';
import { Candle } from '../exchange/types/candle.type';
import { intervalToMs } from './interval.util';
import { CandleCache, CandleCacheDocument } from './schemas/candle-cache.schema';

const MAX_PAGE_SIZE = 1000;

/**
 * Fetches historical klines from Binance (public, read-only) with pagination, and persists
 * them in Mongo so repeated backtests over the same range don't re-hit the network.
 */
@Injectable()
export class HistoricalCandlesService {
  private readonly client: BinanceRestClient;

  constructor(
    @InjectModel(CandleCache.name) private readonly cacheModel: Model<CandleCacheDocument>,
    @Inject(binanceConfig.KEY)
    binance: ReturnType<typeof binanceConfig>,
  ) {
    // Public klines endpoint needs no API key, and always reads real market data.
    this.client = new BinanceRestClient('', '', binance.marketDataBaseUrl, binance.recvWindow);
  }

  async getRange(symbol: string, interval: string, startTime: number, endTime: number): Promise<Candle[]> {
    const intervalMs = intervalToMs(interval);
    const expectedCount = Math.floor((endTime - startTime) / intervalMs) + 1;
    const cachedCount = await this.cacheModel.countDocuments({
      symbol,
      interval,
      openTime: { $gte: startTime, $lte: endTime },
    });

    // Small tolerance for exchange downtime/missing candles — avoids re-fetching forever.
    if (cachedCount < expectedCount * 0.98) {
      await this.fetchAndCache(symbol, interval, startTime, endTime);
    }

    const docs = await this.cacheModel
      .find({ symbol, interval, openTime: { $gte: startTime, $lte: endTime } })
      .sort({ openTime: 1 })
      .lean();

    const now = Date.now();
    return docs.map((d) => ({
      symbol: d.symbol,
      interval: d.interval,
      openTime: d.openTime,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume,
      closeTime: d.closeTime,
      quoteVolume: d.quoteVolume,
      trades: d.trades,
      isClosed: d.closeTime < now,
    }));
  }

  private async fetchAndCache(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
  ): Promise<void> {
    let cursor = startTime;

    while (cursor <= endTime) {
      const page = await this.client.getCandles({
        symbol,
        interval,
        startTime: cursor,
        endTime,
        limit: MAX_PAGE_SIZE,
      });
      if (page.length === 0) break;

      await Promise.all(
        page.map((candle) =>
          this.cacheModel.updateOne(
            { symbol, interval, openTime: candle.openTime },
            { $set: { ...candle } },
            { upsert: true },
          ),
        ),
      );

      const last = page[page.length - 1];
      if (page.length < MAX_PAGE_SIZE || last.closeTime >= endTime) break;
      cursor = last.closeTime + 1;
    }
  }
}
