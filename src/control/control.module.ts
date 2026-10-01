import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ExchangeModule } from '../exchange/exchange.module';
import { TradesModule } from '../trades/trades.module';
import { GlobalApiKeyGuard } from './control-api-key.guard';
import { ControlController } from './control.controller';
import { ControlService } from './control.service';
import { RuntimeStatusService } from './runtime-status.service';
import { BotState, BotStateSchema } from './schemas/bot-state.schema';
import { WorkerHeartbeat, WorkerHeartbeatSchema } from './schemas/worker-heartbeat.schema';
import { WorkerHeartbeatService } from './worker-heartbeat.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BotState.name, schema: BotStateSchema },
      { name: WorkerHeartbeat.name, schema: WorkerHeartbeatSchema },
    ]),
    ExchangeModule,
    TradesModule,
  ],
  controllers: [ControlController],
  providers: [
    ControlService,
    RuntimeStatusService,
    WorkerHeartbeatService,
    { provide: APP_GUARD, useClass: GlobalApiKeyGuard },
  ],
  exports: [ControlService, RuntimeStatusService, WorkerHeartbeatService],
})
export class ControlModule {}
