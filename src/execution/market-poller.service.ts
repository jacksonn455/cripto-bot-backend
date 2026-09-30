import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { executionConfig, trendRegimeConfig } from '../config/configuration';
import { RuntimeStatusService } from '../control/runtime-status.service';
import { ExecutionService } from './execution.service';

const STRATEGY_NAME = 'TrendRegimeStrategy'; // v1: single strategy driving all configured symbols.

/**
 * Drives the signal->risk->execution loop by polling for newly-closed candles, instead of a
 * real-time WebSocket kline stream. Simpler and robust for swing-trading timeframes (1h/4h)
 * where a few seconds/minutes of poll latency after candle close doesn't matter; a future
 * iteration could replace this with WS klines without touching ExecutionService at all.
 */
@Injectable()
export class MarketPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketPollerService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly executionService: ExecutionService,
    private readonly runtimeStatus: RuntimeStatusService,
    @Inject(executionConfig.KEY) private readonly config: ReturnType<typeof executionConfig>,
    @Inject(trendRegimeConfig.KEY) private readonly strategyConfig: ReturnType<typeof trendRegimeConfig>,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.log('EXECUTION_ENABLED=false - automated execution loop is off');
      return;
    }
    this.logger.log(
      `Execution loop enabled, polling every ${this.config.pollIntervalSeconds}s for ${this.strategyConfig.symbols.join(', ')}`,
    );
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalSeconds * 1000);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    for (const symbol of this.strategyConfig.symbols) {
      try {
        await this.executionService.runCycle(symbol, STRATEGY_NAME);
      } catch (err) {
        const message = `Execution cycle failed for ${symbol}: ${(err as Error).message}`;
        this.logger.error(message);
        this.runtimeStatus.recordError(message);
      }
    }
    this.runtimeStatus.recordPoll();
  }
}
