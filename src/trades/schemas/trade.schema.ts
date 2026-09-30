import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TradeMode = 'BACKTEST' | 'PAPER' | 'LIVE';
export type TradeSide = 'LONG' | 'SHORT';
export type TradeStatus = 'OPEN' | 'CLOSED';
export type TradeExitReason =
  | 'TP'
  | 'SL'
  | 'TRAILING'
  | 'SIGNAL'
  | 'MANUAL'
  | 'KILL_SWITCH';

export type TradeDocument = HydratedDocument<Trade>;

@Schema({ timestamps: true, collection: 'trades' })
export class Trade {
  @Prop({ required: true, uppercase: true, index: true })
  symbol: string;

  @Prop({ type: String, required: true, enum: ['LONG', 'SHORT'] })
  side: TradeSide;

  @Prop({ required: true, index: true })
  strategy: string;

  @Prop({ type: String, required: true, enum: ['BACKTEST', 'PAPER', 'LIVE'], index: true })
  mode: TradeMode;

  /** Links trades from the same backtest execution together. */
  @Prop({ index: true })
  runId?: string;

  @Prop({ required: true })
  entryPrice: number;

  @Prop()
  exitPrice?: number;

  @Prop({ required: true })
  qty: number;

  @Prop({ required: true, index: true })
  entryTime: Date;

  @Prop()
  exitTime?: Date;

  @Prop({ default: 0 })
  fees: number;

  @Prop()
  pnl?: number;

  @Prop()
  pnlPct?: number;

  @Prop({ required: true })
  stopLoss: number;

  @Prop()
  takeProfit?: number;

  @Prop({ type: String, required: true, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true })
  status: TradeStatus;

  @Prop({
    type: String,
    enum: ['TP', 'SL', 'TRAILING', 'SIGNAL', 'MANUAL', 'KILL_SWITCH'],
  })
  exitReason?: TradeExitReason;

  /** Worst unrealized loss while the position was open, for post-trade analysis. */
  @Prop()
  maxAdverseExcursion?: number;

  /** Best unrealized gain while the position was open, for post-trade analysis. */
  @Prop()
  maxFavorableExcursion?: number;

  /** Set only by the dev seed script, so the dashboard can flag fake data. Absent on real trades. */
  @Prop({ index: true })
  isSeed?: boolean;
}

export const TradeSchema = SchemaFactory.createForClass(Trade);
TradeSchema.index({ mode: 1, status: 1, symbol: 1, entryTime: -1 });
