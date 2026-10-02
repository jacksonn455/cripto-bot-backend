import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PauseEpisodeDocument = HydratedDocument<PauseEpisode>;

/**
 * One stretch of time the bot was paused, from the pause that started it to the manual resume that
 * ended it (open while resumedAt is absent). A pause requested while already paused (e.g. another
 * stop closes the same day) doesn't start a new episode; it is appended to `additionalReasons`.
 * Observability only: the pause itself lives in bot_state and works even if this write fails.
 */
@Schema({ collection: 'pause_episodes' })
export class PauseEpisode {
  @Prop({ required: true, index: true })
  pausedAt: Date;

  /** What started it: DAILY_LOSS_LIMIT, CONSECUTIVE_STOPS_LIMIT, KILL_SWITCH, MANUAL or a free text. */
  @Prop({ required: true })
  reason: string;

  @Prop({ required: true })
  mode: string;

  @Prop({ type: [Object], default: [] })
  additionalReasons: Array<{ reason: string; at: Date }>;

  @Prop()
  resumedAt?: Date;

  @Prop()
  durationMs?: number;
}

export const PauseEpisodeSchema = SchemaFactory.createForClass(PauseEpisode);
