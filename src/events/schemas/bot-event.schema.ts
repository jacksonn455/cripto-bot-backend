import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BotEventDocument = HydratedDocument<BotEvent>;

/** How long the event history is kept (TTL index on `at`). */
export const BOT_EVENTS_TTL_SECONDS = 30 * 86_400;

/**
 * History of what went out on the SSE stream (minus heartbeats), so a dashboard opened later can
 * show what happened while it was closed. Observability only; nothing reads it for decisions.
 */
@Schema({ collection: 'bot_events', minimize: false })
export class BotEvent {
  @Prop({ required: true, index: true })
  type: string;

  @Prop({ type: Object, required: true })
  data: Record<string, unknown>;

  /** Indexed by the TTL index below. */
  @Prop({ required: true })
  at: Date;
}

export const BotEventSchema = SchemaFactory.createForClass(BotEvent);
// Re-evaluation check on every cycle: "was this symbol's candle already evaluated?"
BotEventSchema.index({ type: 1, 'data.symbol': 1, 'data.candleTime': 1 });
BotEventSchema.index({ at: 1 }, { expireAfterSeconds: BOT_EVENTS_TTL_SECONDS });
