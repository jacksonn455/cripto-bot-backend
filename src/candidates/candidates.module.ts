import { Module } from '@nestjs/common';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { candidatesConfig } from '../config/configuration';
import { ControlModule } from '../control/control.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { StrategyModule } from '../strategy/strategy.module';
import { CANDIDATE_LEDGER_STORE, MongoCandidateLedgerStore } from './candidate-ledger.store';
import { CandidateRecorderService } from './candidate-recorder.service';
import { CandidatesController } from './candidates.controller';
import { CandidatesService } from './candidates.service';
import { BaselineJudge } from './judge/baseline.judge';
import { CANDIDATE_JUDGE } from './judge/candidate-judge.interface';
import { NoopJudge } from './judge/noop.judge';
import { CandidateRecordDoc, CandidateSchema, type CandidateDocument } from './schemas/candidate.schema';
import { ShadowOutcomeService } from './shadow-outcome.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CandidateRecordDoc.name, schema: CandidateSchema }]),
    ControlModule,
    MarketDataModule,
    StrategyModule,
  ],
  controllers: [CandidatesController],
  providers: [
    {
      provide: CANDIDATE_LEDGER_STORE,
      inject: [getModelToken(CandidateRecordDoc.name)],
      useFactory: (model: Model<CandidateDocument>) => new MongoCandidateLedgerStore(model),
    },
    {
      // Deterministic judges only; which one runs matters only in AI_JUDGE_MODE=shadow.
      provide: CANDIDATE_JUDGE,
      inject: [candidatesConfig.KEY],
      useFactory: (config: ReturnType<typeof candidatesConfig>) =>
        config.judge === 'baseline' ? new BaselineJudge() : new NoopJudge(),
    },
    CandidateRecorderService,
    CandidatesService,
    ShadowOutcomeService,
  ],
  exports: [CandidateRecorderService, CANDIDATE_LEDGER_STORE],
})
export class CandidatesModule {}
