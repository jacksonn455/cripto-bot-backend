import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HistoricalCandlesService } from './historical-candles.service';
import { CandleCache, CandleCacheSchema } from './schemas/candle-cache.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: CandleCache.name, schema: CandleCacheSchema }])],
  providers: [HistoricalCandlesService],
  exports: [HistoricalCandlesService],
})
export class MarketDataModule {}
