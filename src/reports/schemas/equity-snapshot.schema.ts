import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EquitySnapshotDocument = HydratedDocument<EquitySnapshot>;

@Schema({ collection: 'equity_snapshots' })
export class EquitySnapshot {
  @Prop({ required: true, enum: ['BACKTEST', 'PAPER', 'LIVE'], index: true })
  mode: string;

  @Prop({ index: true })
  runId?: string;

  @Prop({ required: true, index: true })
  timestamp: Date;

  @Prop({ required: true })
  balance: number;

  @Prop({ required: true })
  equity: number;

  @Prop({ required: true })
  openPositions: number;
}

export const EquitySnapshotSchema = SchemaFactory.createForClass(EquitySnapshot);
EquitySnapshotSchema.index({ mode: 1, runId: 1, timestamp: 1 });
