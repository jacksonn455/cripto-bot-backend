import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BacktestRunDocument = HydratedDocument<BacktestRun>;

// minimize: false — by default Mongoose drops empty objects on save, so a run with no trades
// would lose summary.exitReasonBreakdown ({}) and no longer match MetricsSummary.
@Schema({ collection: 'backtest_runs', minimize: false })
export class BacktestRun {
  @Prop({ required: true, unique: true })
  runId: string;

  @Prop({ required: true, index: true })
  strategy: string;

  @Prop({ type: Object, required: true })
  params: Record<string, unknown>;

  @Prop({ required: true, index: true })
  paramsHash: string;

  @Prop({ type: [String], required: true })
  symbols: string[];

  @Prop({ required: true })
  timeframe: string;

  @Prop({ required: true })
  from: Date;

  @Prop({ required: true })
  to: Date;

  @Prop({ required: true })
  feesPct: number;

  @Prop({ required: true })
  slippagePct: number;

  @Prop({ type: Object, required: true })
  summary: Record<string, unknown>;

  /** Present only when the run used walk-forward windows; per-window summaries. */
  @Prop({ type: [Object] })
  walkForwardWindows?: Record<string, unknown>[];

  /**
   * Buy-and-hold over the same period, per symbol and combined (equal allocation, no fees):
   * "did the strategy beat simply buying and holding?". Absent on runs created before it existed.
   */
  @Prop({ type: Object })
  benchmark?: {
    bySymbol: Record<string, { startPrice: number; endPrice: number; returnPct: number }>;
    buyAndHoldPct: number;
  };

  /** Trading costs actually charged in the simulation. */
  @Prop({ type: Object })
  costs?: { totalFees: number; feesPctOfCapital: number };

  @Prop({ required: true, default: () => new Date() })
  createdAt: Date;
}

export const BacktestRunSchema = SchemaFactory.createForClass(BacktestRun);
