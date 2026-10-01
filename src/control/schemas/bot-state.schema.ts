import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BotStateDocument = HydratedDocument<BotState>;

/** Singleton document (always queried/updated with an empty filter). */
@Schema({ collection: 'bot_state' })
export class BotState {
  @Prop({ required: true, default: false })
  isPaused: boolean;

  @Prop()
  pauseReason?: string;

  @Prop()
  lastReconciliationAt?: Date;

  @Prop({ default: true })
  lastReconciliationOk: boolean;

  /**
   * Set by every manual resume. The consecutive-stop streak only counts trades closed after it, so
   * a resume really lets the bot trade again (before, the old streak kept vetoing every entry).
   * Persisted, not in memory: a process restart (e.g. Render redeploy) must NOT clear the streak,
   * or each restart would silently switch the safety limit off. Absent = never resumed.
   */
  @Prop()
  stopStreakResetAt?: Date;

  @Prop({ required: true, default: () => new Date() })
  updatedAt: Date;
}

export const BotStateSchema = SchemaFactory.createForClass(BotState);
