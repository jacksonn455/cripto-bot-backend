import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ExchangeModule } from '../exchange/exchange.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { ReportsModule } from '../reports/reports.module';
import { RiskModule } from '../risk/risk.module';
import { StrategyModule } from '../strategy/strategy.module';
import { TradesModule } from '../trades/trades.module';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { BacktestRun, BacktestRunSchema } from './schemas/backtest-run.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: BacktestRun.name, schema: BacktestRunSchema }]),
    MarketDataModule,
    StrategyModule,
    RiskModule,
    TradesModule,
    ReportsModule,
    ExchangeModule,
  ],
  controllers: [BacktestController],
  providers: [BacktestService],
  exports: [BacktestService],
})
export class BacktestModule {}
