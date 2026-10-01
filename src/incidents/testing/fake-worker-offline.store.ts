import type { IncidentRecord } from '../schemas/incident.schema';

/** In-memory stand-in with the same atomic semantics as WorkerOfflineIncidentStore. */
export class FakeWorkerOfflineStore {
  record: IncidentRecord | null = null;
  async open(data: Partial<IncidentRecord> & { startedAt: Date }): Promise<boolean> {
    if (this.record?.status === 'ACTIVE') return false;
    this.record = { _id: 'WORKER_OFFLINE', type: 'WORKER_OFFLINE', component: 'Krypto worker', status: 'ACTIVE', notificationSent: false, ...data } as IncidentRecord;
    return true;
  }
  async markNotified(): Promise<void> {
    if (this.record?.status === 'ACTIVE') this.record.notificationSent = true;
  }
  async close(recoveredAt: Date): Promise<IncidentRecord | null> {
    if (this.record?.status !== 'ACTIVE') return null;
    const before = structuredClone(this.record);
    this.record = Object.assign(structuredClone(this.record), { status: 'RECOVERED' as const, recoveredAt });
    return before;
  }
  async get(): Promise<IncidentRecord | null> {
    return this.record;
  }
}
