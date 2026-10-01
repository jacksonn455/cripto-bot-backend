import type { Model } from 'mongoose';
import { IncidentRecord, IncidentRecordDocument, WORKER_OFFLINE_INCIDENT_ID } from './schemas/incident.schema';

const DUPLICATE_KEY = 11000;

export interface OpenWorkerOffline {
  startedAt: Date;
  detectedBy: string;
  lastHeartbeatAt?: Date;
  lastEvaluationAt?: Date;
  lastWorkerStatus?: string;
  lastError?: string;
}

/**
 * Atomic open/close of the WORKER_OFFLINE incident. Plain functions over a Mongoose model so the
 * Nest app and the standalone watchdog script share exactly the same transitions.
 */
export class WorkerOfflineIncidentStore {
  constructor(private readonly model: Model<IncidentRecordDocument>) {}

  /** True only for the caller that moved it to ACTIVE (others see it already open). */
  async open(data: OpenWorkerOffline): Promise<boolean> {
    try {
      const before = await this.model
        .findOneAndUpdate(
          { _id: WORKER_OFFLINE_INCIDENT_ID, status: { $ne: 'ACTIVE' } },
          {
            $set: {
              status: 'ACTIVE',
              type: 'WORKER_OFFLINE',
              component: 'Krypto worker',
              notificationSent: false,
              ...data,
            },
            $unset: { recoveredAt: 1 },
          },
          { upsert: true, returnDocument: 'before' },
        )
        .lean();
      return before === null || before.status !== 'ACTIVE';
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) return false; // already ACTIVE
      throw err;
    }
  }

  async markNotified(): Promise<void> {
    await this.model.updateOne({ _id: WORKER_OFFLINE_INCIDENT_ID, status: 'ACTIVE' }, { $set: { notificationSent: true } });
  }

  /** Closes it if ACTIVE and returns the incident as it was (null = nothing was open, or someone else closed it). */
  async close(recoveredAt: Date): Promise<IncidentRecord | null> {
    return this.model
      .findOneAndUpdate(
        { _id: WORKER_OFFLINE_INCIDENT_ID, status: 'ACTIVE' },
        { $set: { status: 'RECOVERED', recoveredAt } },
        { returnDocument: 'before' },
      )
      .lean<IncidentRecord>();
  }

  async get(): Promise<IncidentRecord | null> {
    return this.model.findById(WORKER_OFFLINE_INCIDENT_ID).lean<IncidentRecord>();
  }
}
