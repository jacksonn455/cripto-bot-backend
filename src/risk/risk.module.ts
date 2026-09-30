import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ControlModule } from '../control/control.module';
import { Trade, TradeSchema } from '../trades/schemas/trade.schema';
import { RiskContextBuilderService } from './risk-context-builder.service';
import { RiskManagerService } from './risk-manager.service';
import { SignalRecord, SignalSchema } from './schemas/signal.schema';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SignalRecord.name, schema: SignalSchema },
      { name: Trade.name, schema: TradeSchema },
    ]),
    ControlModule,
  ],
  controllers: [SignalsController],
  providers: [RiskManagerService, SignalsService, RiskContextBuilderService],
  exports: [RiskManagerService, SignalsService, RiskContextBuilderService],
})
export class RiskModule {}
