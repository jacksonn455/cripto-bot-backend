import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SignalDocument = HydratedDocument<SignalRecord>;

@Schema({ collection: 'signals' })
export class SignalRecord {
  @Prop({ required: true, index: true })
  strategy: string;

  @Prop({ required: true, uppercase: true, index: true })
  symbol: string;

  @Prop({ required: true })
  signal: string;

  /** Strategy's own explanation for the signal (paper/live only; not stored for backtests). */
  @Prop()
  reason?: string;

  /** Close price the signal was evaluated at (paper/live only). */
  @Prop()
  price?: number;

  @Prop({ type: Object })
  indicators: Record<string, number | undefined>;

  @Prop({ required: true, index: true })
  candleTime: Date;

  @Prop({ required: true })
  approved: boolean;

  @Prop()
  rejectReason?: string;

  @Prop({ required: true, enum: ['BACKTEST', 'PAPER', 'LIVE'] })
  mode: string;

  @Prop({ index: true })
  runId?: string;
}

export const SignalSchema = SchemaFactory.createForClass(SignalRecord);
SignalSchema.index({ candleTime: 1, strategy: 1, symbol: 1 });
