import { Global, Module } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { NotificationsModule } from '../notifications/notifications.module';
import { DependencyMonitorService } from './dependency-monitor.service';
import { IncidentService } from './incident.service';
import { WORKER_OFFLINE_STORE } from './incident.tokens';
import { IncidentRecord, IncidentRecordDocument, IncidentRecordSchema } from './schemas/incident.schema';
import { WorkerOfflineIncidentStore } from './worker-offline-incident.store';

/**
 * Operational incidents → Discord (same webhook as trades). Global so the execution loop and the
 * process-level handlers in main.ts can report without wiring every module to it.
 */
@Global()
@Module({
  imports: [
    NotificationsModule,
    MongooseModule.forFeature([{ name: IncidentRecord.name, schema: IncidentRecordSchema }]),
  ],
  providers: [
    IncidentService,
    DependencyMonitorService,
    {
      provide: WORKER_OFFLINE_STORE,
      inject: [getModelToken(IncidentRecord.name)],
      useFactory: (model: Model<IncidentRecordDocument>) => new WorkerOfflineIncidentStore(model),
    },
  ],
  exports: [IncidentService],
})
export class IncidentsModule {}
