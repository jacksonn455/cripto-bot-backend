import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FundingHistoryDocument = HydratedDocument<FundingHistory>;

/**
 * Settled funding of Binance USD-M perpetuals (one row per 8h settlement), cached for backtests
 * that model a short's carry with the real funding instead of a flat daily rate. Unlike
 * `funding_rates` (the scanner's snapshots of the NEXT rate), these are what was actually paid.
 */
@Schema({ collection: 'funding_history' })
export class FundingHistory {
  @Prop({ required: true, uppercase: true })
  symbol: string;

  @Prop({ required: true })
  fundingTime: Date;

  /** Fraction of the notional; positive = longs paid shorts. */
  @Prop({ required: true })
  rate: number;
}

export const FundingHistorySchema = SchemaFactory.createForClass(FundingHistory);
FundingHistorySchema.index({ symbol: 1, fundingTime: 1 }, { unique: true });
