import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ExchangeModule } from '../exchange/exchange.module';
import { TradesModule } from '../trades/trades.module';
import { GlobalApiKeyGuard } from './control-api-key.guard';
import { ControlController } from './control.controller';
import { ControlService } from './control.service';
import { EVALUATION_SNAPSHOT_STORE, MongoEvaluationSnapshotStore } from './evaluation-snapshot.store';
import { RuntimeStatusService } from './runtime-status.service';
import { BotState, BotStateSchema } from './schemas/bot-state.schema';
import {
  EvaluationSnapshotDocument,
  EvaluationSnapshotRecord,
  EvaluationSnapshotSchema,
} from './schemas/evaluation-snapshot.schema';
import { WorkerHeartbeat, WorkerHeartbeatSchema } from './schemas/worker-heartbeat.schema';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BotState.name, schema: BotStateSchema },
      { name: WorkerHeartbeat.name, schema: WorkerHeartbeatSchema },
      { name: EvaluationSnapshotRecord.name, schema: EvaluationSnapshotSchema },
    ]),
    ExchangeModule,
    TradesModule,
  ],
  controllers: [ControlController],
  providers: [
    ControlService,
    RuntimeStatusService,
    WorkerHeartbeatService,
    {
      provide: EVALUATION_SNAPSHOT_STORE,
      inject: [getModelToken(EvaluationSnapshotRecord.name)],
      useFactory: (model: Model<EvaluationSnapshotDocument>) => new MongoEvaluationSnapshotStore(model),
    },
    { provide: APP_GUARD, useClass: GlobalApiKeyGuard },
  ],
  exports: [ControlService, RuntimeStatusService, WorkerHeartbeatService, EVALUATION_SNAPSHOT_STORE],
})
export class ControlModule {}
