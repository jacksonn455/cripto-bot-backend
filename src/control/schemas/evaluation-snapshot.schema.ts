import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EvaluationSnapshotDocument = HydratedDocument<EvaluationSnapshotRecord>;

/**
 * The latest evaluation of each symbol, per `mode:symbol` (_id): which candle, the three entry
 * conditions with their values, the indicators and what the worker decided. Persisted so the
 * dashboard (GET /bot/status) shows it right after a restart instead of waiting for the next candle
 * close. Observability only: trading decisions never read it (evaluation_checkpoints guards those).
 */
@Schema({ collection: 'evaluation_snapshots', minimize: false })
export class EvaluationSnapshotRecord {
  @Prop({ required: true })
  _id: string;

  @Prop({ required: true })
  mode: string;

  @Prop({ required: true })
  symbol: string;

  @Prop()
  timeframe?: string;

  @Prop()
  regimeTimeframe?: string;

  /** Epoch ms of the evaluated (closed) candle. Absent while the symbol only has an error. */
  @Prop()
  candleOpenTime?: number;

  @Prop()
  candleCloseTime?: number;

  @Prop()
  evaluatedAt?: Date;

  /** `cycle` = the loop's real evaluation; `reconciliation` = informational re-run after a restart. */
  @Prop()
  source?: string;

  @Prop()
  action?: string;

  @Prop()
  reason?: string;

  @Prop()
  price?: number;

  @Prop({ type: Object })
  indicators?: Record<string, number | undefined>;

  @Prop()
  side?: string;

  @Prop({ type: [Object], default: undefined })
  conditions?: Array<Record<string, unknown>>;

  @Prop({ type: Object })
  decision?: { outcome: string; reason: string };

  /** Last failure fetching this symbol's market data; cleared by the next successful fetch. */
  @Prop()
  lastError?: string;

  @Prop()
  lastErrorAt?: Date;
}

export const EvaluationSnapshotSchema = SchemaFactory.createForClass(EvaluationSnapshotRecord);
