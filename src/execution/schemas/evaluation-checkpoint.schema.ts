import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EvaluationCheckpointDocument = HydratedDocument<EvaluationCheckpoint>;

/**
 * Last closed candle the execution loop fully evaluated, per `mode:symbol:timeframe` (_id).
 * Persisted so a restart neither re-evaluates a candle already handled nor loses track of the
 * candles it missed while down. The claim fields make one evaluation per candle hold even when
 * two processes run the loop at once (a deploy overlap).
 */
@Schema({ collection: 'evaluation_checkpoints' })
export class EvaluationCheckpoint {
  @Prop({ required: true })
  _id: string;

  /** closeTime (epoch ms) of the last candle whose evaluation completed. */
  @Prop()
  lastCloseTime?: number;

  @Prop()
  evaluatedAt?: Date;

  /** Candle currently being evaluated, by whom and since when (a lease: stale claims are taken over). */
  @Prop()
  claimCloseTime?: number;

  @Prop()
  claimedBy?: string;

  @Prop()
  claimedAt?: Date;
}

export const EvaluationCheckpointSchema = SchemaFactory.createForClass(EvaluationCheckpoint);
