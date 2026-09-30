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

  @Prop({ required: true, default: () => new Date() })
  updatedAt: Date;
}

export const BotStateSchema = SchemaFactory.createForClass(BotState);
