import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CandidateDocument = HydratedDocument<CandidateRecordDoc>;

/**
 * Candidate ledger: one document per entry setup the strategy saw trigger — accepted or rejected —
 * with every gate, the features, the risk/pause outcome, and later a judge assessment and a shadow
 * outcome. _id = candidateId in paper/live (re-evaluating a candle overwrites its row instead of
 * duplicating it), `${runId}|${candidateId}` in backtests (many runs share candidate ids).
 * Observability only: trading never reads it.
 */
@Schema({ collection: 'candidate_assessments', minimize: false })
export class CandidateRecordDoc {
  @Prop({ required: true })
  _id: string;

  @Prop({ required: true, index: true })
  candidateId: string;

  @Prop({ required: true, index: true })
  opportunityId: string;

  @Prop({ required: true, enum: ['BACKTEST', 'PAPER', 'LIVE'] })
  mode: string;

  @Prop({ index: true })
  runId?: string;

  @Prop({ required: true, uppercase: true })
  symbol: string;

  @Prop({ required: true })
  timeframe: string;

  @Prop()
  regimeTimeframe?: string;

  @Prop({ required: true })
  candleCloseTime: number;

  @Prop({ required: true, enum: ['LONG', 'SHORT'] })
  side: string;

  @Prop({ required: true })
  setupType: string;

  @Prop({ required: true })
  strategy: string;

  @Prop({ required: true })
  price: number;

  @Prop()
  stopLoss?: number;

  @Prop({ required: true, enum: ['ACCEPTED', 'REJECTED'] })
  strategyDecision: string;

  @Prop({ type: [Object], required: true })
  gates: Array<Record<string, unknown>>;

  @Prop()
  strategyRejectedAt?: string;

  @Prop({ type: Object })
  features: Record<string, unknown> | null;

  @Prop({ type: Object })
  risk?: Record<string, unknown>;

  @Prop({ type: Object })
  riskIfResumed?: Record<string, unknown>;

  @Prop({ required: true })
  botPaused: boolean;

  @Prop()
  pauseReason?: string;

  /** null = entered. */
  @Prop({ type: String, default: null })
  rejectedAt: string | null;

  @Prop({ required: true, enum: ['ENTERED', 'REJECTED', 'ENTRY_FAILED'] })
  finalAction: string;

  @Prop({ required: true })
  evaluatedAt: Date;

  @Prop({ type: Object })
  assessment?: Record<string, unknown>;

  @Prop({ type: Object })
  shadow?: Record<string, unknown>;
}

export const CandidateSchema = SchemaFactory.createForClass(CandidateRecordDoc);
CandidateSchema.index({ mode: 1, candleCloseTime: -1 });
CandidateSchema.index({ mode: 1, symbol: 1, candleCloseTime: -1 });
