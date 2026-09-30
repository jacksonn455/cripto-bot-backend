import { Module } from '@nestjs/common';
import { ControlModule } from '../control/control.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { ReportsModule } from '../reports/reports.module';
import { RiskModule } from '../risk/risk.module';
import { StrategyModule } from '../strategy/strategy.module';
import { TradesModule } from '../trades/trades.module';
import { EquityRecorderService } from './equity-recorder.service';
import { ExecutionService } from './execution.service';
import { MarketPollerService } from './market-poller.service';
import { ReconciliationService } from './reconciliation.service';
import { UserDataStreamService } from './user-data-stream.service';

@Module({
  imports: [ExchangeModule, StrategyModule, RiskModule, TradesModule, ControlModule, ReportsModule],
  providers: [
    ExecutionService,
    ReconciliationService,
    MarketPollerService,
    UserDataStreamService,
    EquityRecorderService,
  ],
  exports: [ExecutionService, ReconciliationService],
})
export class ExecutionModule {}
