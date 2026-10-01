import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type IncidentRecordDocument = HydratedDocument<IncidentRecord>;

/** _id of the worker-liveness incident (the only one shared across processes). */
export const WORKER_OFFLINE_INCIDENT_ID = 'WORKER_OFFLINE';

/**
 * Persisted incident state, for incidents that must survive the process that detected them:
 * "worker offline" is opened by whoever notices (the in-process stall watchdog, or the external
 * heartbeat watchdog cron while the worker is dead) and closed by whoever sees it come back.
 * Transitions are atomic (status ACTIVE <-> RECOVERED), so exactly one party sends each message.
 */
@Schema({ collection: 'incidents' })
export class IncidentRecord {
  @Prop({ required: true })
  _id: string;

  @Prop({ required: true, enum: ['ACTIVE', 'RECOVERED'] })
  status: 'ACTIVE' | 'RECOVERED';

  @Prop({ required: true })
  type: string;

  @Prop({ required: true })
  component: string;

  @Prop({ required: true })
  startedAt: Date;

  @Prop()
  recoveredAt?: Date;

  /** Who opened it: `in-process-watchdog` | `heartbeat-watchdog-cron`. */
  @Prop()
  detectedBy?: string;

  @Prop()
  lastError?: string;

  /** Whether the "incident" message actually went out (so the recovery is only sent if it did). */
  @Prop({ default: false })
  notificationSent: boolean;

  /** Context at detection time. */
  @Prop()
  lastHeartbeatAt?: Date;

  @Prop()
  lastEvaluationAt?: Date;

  @Prop()
  lastWorkerStatus?: string;
}

export const IncidentRecordSchema = SchemaFactory.createForClass(IncidentRecord);
