import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FundingRateDocument = HydratedDocument<FundingRate>;

@Schema({ collection: 'funding_rates' })
export class FundingRate {
  @Prop({ required: true, uppercase: true, index: true })
  symbol: string;

  @Prop({ required: true, default: 'BINANCE' })
  exchange: string;

  /** Fraction, e.g. 0.0001 = 0.01% per 8h funding interval. */
  @Prop({ required: true })
  rate: number;

  @Prop({ required: true })
  nextFundingTime: Date;

  @Prop({ required: true, index: true })
  timestamp: Date;
}

export const FundingRateSchema = SchemaFactory.createForClass(FundingRate);
FundingRateSchema.index({ symbol: 1, timestamp: 1 });
