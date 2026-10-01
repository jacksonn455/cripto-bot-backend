import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WorkerHeartbeatDocument = HydratedDocument<WorkerHeartbeat>;

/** _id of the singleton document: one execution loop per deployment. */
export const WORKER_HEARTBEAT_ID = 'krypto-worker';

/** A heartbeat gap the worker found when it started (it was not running in between). */
@Schema({ _id: false })
export class WorkerDowntime {
  /** Last heartbeat of the previous run. */
  @Prop({ required: true })
  from: Date;

  /** When this run started. */
  @Prop({ required: true })
  to: Date;

  /** Last candle evaluation before the gap. */
  @Prop()
  lastEvaluationAt?: Date;

  /** How the previous run ended: a recorded shutdown (e.g. SIGTERM) or absent = it just vanished. */
  @Prop()
  previousStopReason?: string;
}
const WorkerDowntimeSchema = SchemaFactory.createForClass(WorkerDowntime);

/**
 * Written ONLY by the execution loop (MarketPollerService, once per tick) — never by a request —
 * so "is the worker alive?" can be answered from persisted state rather than inferred from the
 * absence of trades, and survives restarts (a dashboard opened after a night offline still sees it).
 */
@Schema({ collection: 'worker_heartbeat' })
export class WorkerHeartbeat {
  @Prop({ required: true })
  _id: string;

  /** Process that wrote the last heartbeat (host:pid:random). */
  @Prop({ required: true })
  instanceId: string;

  /** crashed = the previous run recorded an uncaughtException before exiting. */
  @Prop({ required: true, enum: ['running', 'stopped', 'crashed'] })
  status: 'running' | 'stopped' | 'crashed';

  @Prop({ required: true })
  startedAt: Date;

  @Prop({ required: true })
  lastHeartbeatAt: Date;

  /** Last time a newly closed candle was evaluated (hourly on 1h). */
  @Prop()
  lastEvaluationAt?: Date;

  @Prop()
  lastErrorAt?: Date;

  @Prop()
  lastError?: string;

  /** Set by a clean shutdown (SIGTERM from a deploy, a platform stop/spin-down, Ctrl+C). */
  @Prop()
  stoppedAt?: Date;

  @Prop()
  stopReason?: string;

  /** Sanitized message of the uncaughtException that ended the previous run. */
  @Prop()
  crashError?: string;

  /** The most recent gap found at startup (kept until the next one). */
  @Prop({ type: WorkerDowntimeSchema })
  lastDowntime?: WorkerDowntime;
}

export const WorkerHeartbeatSchema = SchemaFactory.createForClass(WorkerHeartbeat);
