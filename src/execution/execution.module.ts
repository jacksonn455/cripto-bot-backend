import { Module } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ControlModule } from '../control/control.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { ReportsModule } from '../reports/reports.module';
import { RiskModule } from '../risk/risk.module';
import { StrategyModule } from '../strategy/strategy.module';
import { TradesModule } from '../trades/trades.module';
import { EquityRecorderService } from './equity-recorder.service';
import { EVALUATION_CHECKPOINT_STORE, MongoEvaluationCheckpointStore } from './evaluation-checkpoint.store';
import { ExecutionService } from './execution.service';
import { MarketPollerService } from './market-poller.service';
import { ReconciliationService } from './reconciliation.service';
import {
  EvaluationCheckpoint,
  EvaluationCheckpointDocument,
  EvaluationCheckpointSchema,
} from './schemas/evaluation-checkpoint.schema';
import { UserDataStreamService } from './user-data-stream.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: EvaluationCheckpoint.name, schema: EvaluationCheckpointSchema }]),
    ExchangeModule,
    StrategyModule,
    RiskModule,
    TradesModule,
    ControlModule,
    ReportsModule,
  ],
  providers: [
    ExecutionService,
    ReconciliationService,
    MarketPollerService,
    UserDataStreamService,
    EquityRecorderService,
    {
      provide: EVALUATION_CHECKPOINT_STORE,
      inject: [getModelToken(EvaluationCheckpoint.name)],
      useFactory: (model: Model<EvaluationCheckpointDocument>) => new MongoEvaluationCheckpointStore(model),
    },
  ],
  exports: [ExecutionService, ReconciliationService],
})
export class ExecutionModule {}
