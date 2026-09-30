import { Module } from '@nestjs/common';
import { BacktestModule } from '../backtest/backtest.module';
import { ControlModule } from '../control/control.module';
import { ExchangeModule } from '../exchange/exchange.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { ReportsModule } from '../reports/reports.module';
import { RiskModule } from '../risk/risk.module';
import { StrategyModule } from '../strategy/strategy.module';
import { TradesModule } from '../trades/trades.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AGENT_RUNNER } from './providers/agent-runner.interface';
import { OpenAiAgentsRunner } from './providers/openai-agents.runner';
import { TradingDataTools } from './tools/trading-data.tools';

/**
 * AI/Agents layer (analysis, explanation, recommendations). Depends on the trading modules for
 * read access; no trading module depends on it, so it can be disabled or fail independently.
 */
@Module({
  imports: [ControlModule, ReportsModule, TradesModule, RiskModule, StrategyModule, BacktestModule, IndicatorsModule, ExchangeModule],
  controllers: [AiController],
  providers: [AiService, TradingDataTools, OpenAiAgentsRunner, { provide: AGENT_RUNNER, useExisting: OpenAiAgentsRunner }],
  exports: [AiService],
})
export class AiModule {}
