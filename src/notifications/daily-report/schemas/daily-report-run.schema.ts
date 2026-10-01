import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DailyReportRunDocument = HydratedDocument<DailyReportRun>;

/**
 * One document per local day whose report was sent (_id = "YYYY-MM-DD" in NOTIFICATIONS_TIME_ZONE).
 * The unique _id is the claim: a restart, or a second process, can never send the same day twice.
 */
@Schema({ collection: 'daily_report_runs' })
export class DailyReportRun {
  @Prop({ required: true })
  _id: string;

  /** Indexed by the TTL index below. */
  @Prop({ required: true })
  sentAt: Date;
}

export const DailyReportRunSchema = SchemaFactory.createForClass(DailyReportRun);
DailyReportRunSchema.index({ sentAt: 1 }, { expireAfterSeconds: 90 * 86_400 });
