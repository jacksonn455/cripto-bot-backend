import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CandleCacheDocument = HydratedDocument<CandleCache>;

/** Local persistent cache of historical klines, avoids re-fetching the same range from Binance. */
@Schema({ collection: 'market_candles' })
export class CandleCache {
  @Prop({ required: true, uppercase: true })
  symbol: string;

  @Prop({ required: true })
  interval: string;

  @Prop({ required: true })
  openTime: number;

  @Prop({ required: true })
  open: number;

  @Prop({ required: true })
  high: number;

  @Prop({ required: true })
  low: number;

  @Prop({ required: true })
  close: number;

  @Prop({ required: true })
  volume: number;

  @Prop({ required: true })
  closeTime: number;

  @Prop({ required: true })
  quoteVolume: number;

  @Prop({ required: true })
  trades: number;
}

export const CandleCacheSchema = SchemaFactory.createForClass(CandleCache);
CandleCacheSchema.index({ symbol: 1, interval: 1, openTime: 1 }, { unique: true });
