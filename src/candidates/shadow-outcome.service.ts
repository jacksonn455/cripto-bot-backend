import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { candidatesConfig, executionConfig } from '../config/configuration';
import type { Candle } from '../exchange/types/candle.type';
import { HistoricalCandlesService } from '../market-data/historical-candles.service';
import { intervalToMs } from '../market-data/interval.util';
import { StrategyRegistryService } from '../strategy/strategy-registry.service';
import { strategyWindowSize } from '../strategy/strategy-window';
import { CANDIDATE_LEDGER_STORE, type CandidateLedgerStore } from './candidate-ledger.store';
import type { CandidateRecord } from './candidate.types';
import { simulateShadowOutcome } from './shadow-outcome';

/** Shadow outcomes are (re)computed for paper/live candidates up to this old. */
const SHADOW_HORIZON_MS = 60 * 86_400_000;
const BATCH = 200;

export interface ShadowRefreshResult {
  examined: number;
  closed: number;
  open: number;
  skipped: number;
}

/**
 * Fills in what paper/live candidates would have done if traded (simulateShadowOutcome: the
 * backtest's exit step on real candles). Read-only towards trading: market data from the candle
 * cache/public klines, writes only the ledger's `shadow` field. Runs in the worker on a timer
 * (CANDIDATE_SHADOW_REFRESH_MINUTES) and on demand.
 */
@Injectable()
export class ShadowOutcomeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ShadowOutcomeService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @Inject(CANDIDATE_LEDGER_STORE) private readonly store: CandidateLedgerStore,
    private readonly historicalCandles: HistoricalCandlesService,
    private readonly strategies: StrategyRegistryService,
    @Inject(candidatesConfig.KEY) private readonly config: ReturnType<typeof candidatesConfig>,
    @Inject(executionConfig.KEY) private readonly execution: ReturnType<typeof executionConfig>,
  ) {}

  onModuleInit(): void {
    const minutes = this.config.shadowRefreshMinutes;
    if (!this.execution.enabled || !this.config.ledgerEnabled || minutes <= 0) return;
    this.timer = setInterval(() => void this.refreshPending().catch(() => undefined), minutes * 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refreshPending(now = Date.now()): Promise<ShadowRefreshResult> {
    const result: ShadowRefreshResult = { examined: 0, closed: 0, open: 0, skipped: 0 };
    if (this.running) return result;
    this.running = true;
    try {
      const pending = await this.store.findShadowPending(['PAPER', 'LIVE'], now - SHADOW_HORIZON_MS, BATCH);
      const groups = new Map<string, CandidateRecord[]>();
      for (const r of pending) {
        const key = `${r.symbol}|${r.timeframe}|${r.regimeTimeframe ?? ''}|${r.strategy}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      for (const records of groups.values()) await this.refreshGroup(records, now, result);
      if (result.examined) this.logger.log(`shadow_refresh examined=${result.examined} closed=${result.closed} open=${result.open} skipped=${result.skipped}`);
    } catch (err) {
      this.logger.warn(`shadow_refresh_failed error="${(err as Error).message}"`);
    } finally {
      this.running = false;
    }
    return result;
  }

  private async refreshGroup(records: CandidateRecord[], now: number, result: ShadowRefreshResult): Promise<void> {
    const { symbol, timeframe, regimeTimeframe, strategy: strategyName } = records[0];
    let strategy;
    try {
      strategy = this.strategies.get(strategyName);
    } catch {
      result.skipped += records.length;
      result.examined += records.length;
      return;
    }
    // Exits are judged with the strategy's CURRENT parameters (paper/live run one configuration).
    const size = strategyWindowSize(strategy.getParams?.().emaRegime ?? 200);
    const first = Math.min(...records.map((r) => r.candleCloseTime));
    const load = async (interval: string): Promise<Candle[]> =>
      (await this.historicalCandles.getRange(symbol, interval, first - (size + 2) * intervalToMs(interval), now)).filter(
        (c) => c.isClosed,
      );
    const candles = await load(timeframe);
    const regimeCandles = regimeTimeframe && regimeTimeframe !== timeframe ? await load(regimeTimeframe) : undefined;

    for (const r of records) {
      result.examined++;
      const outcome =
        r.stopLoss === undefined
          ? null
          : simulateShadowOutcome({
              strategy,
              symbol,
              side: r.side,
              price: r.price,
              stopLoss: r.stopLoss,
              candleCloseTime: r.candleCloseTime,
              candles,
              regimeCandles,
              windowSize: size,
            });
      if (!outcome) {
        result.skipped++;
        continue;
      }
      await this.store.setShadow(r, { ...outcome, computedAt: new Date(now) });
      if (outcome.status === 'CLOSED') result.closed++;
      else result.open++;
    }
  }
}
