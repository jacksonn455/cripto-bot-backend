import { Module } from '@nestjs/common';
import { IndicatorsModule } from '../indicators/indicators.module';
import { StrategyController } from './strategy.controller';
import { StrategyRegistryService } from './strategy-registry.service';
import { STRATEGIES } from './strategy.tokens';
import { TrendRegimeStrategy } from './trend-regime.strategy';

@Module({
  imports: [IndicatorsModule],
  controllers: [StrategyController],
  providers: [
    TrendRegimeStrategy,
    {
      provide: STRATEGIES,
      inject: [TrendRegimeStrategy],
      useFactory: (trendRegime: TrendRegimeStrategy) => [trendRegime],
    },
    StrategyRegistryService,
  ],
  exports: [StrategyRegistryService],
})
export class StrategyModule {}
