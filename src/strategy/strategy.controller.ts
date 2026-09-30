import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { trendRegimeConfig } from '../config/configuration';
import { StrategyRegistryService } from './strategy-registry.service';

/** The strategy that the live/paper execution loop runs (see MarketPollerService). */
const LIVE_STRATEGY = 'TrendRegimeStrategy';

@ApiTags('strategies')
@Controller('strategies')
export class StrategyController {
  constructor(
    private readonly registry: StrategyRegistryService,
    @Inject(trendRegimeConfig.KEY) private readonly trendRegime: ReturnType<typeof trendRegimeConfig>,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Registered strategies with their tunable parameters (current values and ranges) and what the live loop runs',
  })
  list() {
    const params = (s: ReturnType<StrategyRegistryService['getAll']>[number]) => {
      const current = s.getParams?.() ?? {};
      return (s.paramSpec ?? []).map((p) => ({ ...p, value: current[p.key] }));
    };
    return {
      strategies: this.registry.getAll().map((s) => ({ name: s.name, params: params(s) })),
      live: {
        strategy: LIVE_STRATEGY,
        symbols: this.trendRegime.symbols,
        timeframe: this.trendRegime.timeframe,
        regimeTimeframe: this.trendRegime.regimeTimeframe,
      },
    };
  }
}
