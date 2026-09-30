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

@Module({
  imports: [
    MongooseModule.forFeature([{ name: BotState.name, schema: BotStateSchema }]),
    ExchangeModule,
    TradesModule,
  ],
  controllers: [ControlController],
  providers: [ControlService, RuntimeStatusService, { provide: APP_GUARD, useClass: GlobalApiKeyGuard }],
  exports: [ControlService, RuntimeStatusService],
})
export class ControlModule {}
