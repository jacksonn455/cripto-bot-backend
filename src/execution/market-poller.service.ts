import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { executionConfig, trendRegimeConfig } from '../config/configuration';
import { RuntimeStatusService } from '../control/runtime-status.service';
import { WORKER_LOG, WorkerHeartbeatService } from '../control/worker-heartbeat.service';
import { IncidentService } from '../incidents/incident.service';
import { CycleOutcome, ExecutionService, MarketDataError } from './execution.service';

const STRATEGY_NAME = 'TrendRegimeStrategy'; // v1: single strategy driving all configured symbols.
/** How often the watchdog checks that ticks keep completing (independent of the tick timer). */
const WATCHDOG_INTERVAL_MS = 60_000;

class SymbolTimeoutError extends Error {}

/**
 * The Krypto worker: drives the signal->risk->execution loop by polling for newly-closed candles.
 * Started by the process itself at boot (onModuleInit) — never by an HTTP request, the dashboard
 * or a WebSocket — and runs for as long as the process does.
 *
 * - One failing or hanging symbol never stops the others: each runs in its own try/catch with a
 *   time limit. Symbols run one after another on purpose: risk limits (max open positions, total
 *   exposure) are portfolio-wide, and evaluating in parallel would let two entries pass the same check.
 * - Ticks never overlap; a tick that is still running makes the next one skip.
 * - Every tick writes the persisted heartbeat; a separate watchdog flags a loop that stops ticking.
 */
@Injectable()
export class MarketPollerService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(MarketPollerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setInterval>;
  private tickRunning = false;
  /** Symbols whose previous cycle hasn't settled yet (timed out but still running). */
  private readonly symbolsInFlight = new Set<string>();
  /** Consecutive failed cycles per symbol, to log `recovered` when one succeeds again. */
  private readonly failures = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly executionService: ExecutionService,
    private readonly runtimeStatus: RuntimeStatusService,
    private readonly heartbeat: WorkerHeartbeatService,
    @Inject(executionConfig.KEY) private readonly config: ReturnType<typeof executionConfig>,
    @Inject(trendRegimeConfig.KEY) private readonly strategyConfig: ReturnType<typeof trendRegimeConfig>,
    private readonly incidents: IncidentService,
  ) {}

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logger.log(`${WORKER_LOG} disabled (EXECUTION_ENABLED=false) - automated execution loop is off`);
      return;
    }
    this.logger.log(
      `${WORKER_LOG} starting: polling every ${this.config.pollIntervalSeconds}s for ${this.strategyConfig.symbols.join(', ')} ` +
        `(instance ${this.heartbeat.instanceId})`,
    );
    this.heartbeat.markLoopStarted();
    this.timer = setInterval(() => void this.tick(), this.config.pollIntervalSeconds * 1000);
    this.watchdog = setInterval(() => this.heartbeat.checkStall(), WATCHDOG_INTERVAL_MS);
    // Persist the start (and detect downtime) before the first tick; beat() retries it if Mongo is down.
    void this.heartbeat
      .registerStart()
      .catch((err: Error) => this.logger.warn(`${WORKER_LOG} start not persisted yet (${err.message}) - retrying on next tick`))
      .finally(() => void this.tick());
  }

  onModuleDestroy(): void {
    this.clearTimers();
  }

  /** SIGTERM/SIGINT (deploy, platform stop, Ctrl+C) — needs app.enableShutdownHooks() in main.ts. */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.clearTimers();
    if (this.config.enabled) await this.heartbeat.markStopped(signal ?? 'shutdown');
  }

  private clearTimers(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
  }

  /** One loop iteration. Never throws: everything is caught per symbol and the heartbeat is always written. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.tickRunning) {
      this.logger.warn(`${WORKER_LOG} tick_skipped previous tick still running`);
      return;
    }
    this.tickRunning = true;
    const errors: string[] = [];
    let evaluated = false;
    let missedCandles = 0;
    try {
      for (const symbol of this.strategyConfig.symbols) {
        const outcome = await this.runSymbol(symbol, errors);
        if (outcome?.status === 'evaluated') {
          evaluated = true;
          missedCandles += outcome.missedCandles;
        }
      }
      if (evaluated) this.logger.log(`${WORKER_LOG} evaluation_completed symbols=${this.strategyConfig.symbols.join(',')}`);
      this.runtimeStatus.recordPoll();
    } catch (err) {
      // Defensive: per-symbol errors are already caught; nothing may escape a timer callback.
      this.logger.error(`${WORKER_LOG} tick_failed error="${(err as Error).message}"`);
      errors.push(`Tick failed: ${(err as Error).message}`);
    } finally {
      this.tickRunning = false;
      await this.heartbeat.beat({ evaluated, errors, missedCandles });
    }
  }

  private async runSymbol(symbol: string, errors: string[]): Promise<CycleOutcome | null> {
    if (this.symbolsInFlight.has(symbol)) {
      const message = `Execution cycle for ${symbol} still running from a previous tick - skipped`;
      this.logger.warn(`${WORKER_LOG} evaluation_skipped symbol=${symbol} reason="previous cycle still running"`);
      errors.push(message);
      return null;
    }

    this.symbolsInFlight.add(symbol);
    const cycle = this.executionService.runCycle(symbol, STRATEGY_NAME);
    // The flag clears when the cycle really settles, even if we stopped waiting for it.
    void cycle.then(
      () => this.symbolsInFlight.delete(symbol),
      () => this.symbolsInFlight.delete(symbol),
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const limitMs = this.config.symbolCycleTimeoutSeconds * 1000;
    try {
      const outcome = await Promise.race([
        cycle,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new SymbolTimeoutError(`timed out after ${limitMs / 1000}s`)), limitMs);
        }),
      ]);
      // The cycle completed: candles were fetched and the evaluation ran.
      this.incidents.reportSuccess(`MARKET_DATA:${symbol}`);
      this.incidents.reportSuccess(`EVALUATION:${symbol}`);
      const failed = this.failures.get(symbol) ?? 0;
      if (failed > 0) {
        this.logger.log(`${WORKER_LOG} recovered symbol=${symbol} after ${failed} failed cycle(s)`);
        this.failures.delete(symbol);
      }
      return outcome;
    } catch (err) {
      const message = `Execution cycle failed for ${symbol}: ${(err as Error).message}`;
      this.failures.set(symbol, (this.failures.get(symbol) ?? 0) + 1);
      this.logger.error(`${WORKER_LOG} evaluation_failed symbol=${symbol} error="${(err as Error).message}"`);
      this.runtimeStatus.recordError(message);
      errors.push(message);
      if (err instanceof MarketDataError) {
        this.incidents.reportFailure({
          key: `MARKET_DATA:${symbol}`,
          type: 'MARKET_DATA_ERROR',
          component: 'Binance API (market data)',
          error: err,
          symbol,
        });
      } else {
        // Candles arrived; whatever failed after that (Mongo, risk, order, timeout) is the cycle's.
        if (!(err instanceof SymbolTimeoutError)) this.incidents.reportSuccess(`MARKET_DATA:${symbol}`);
        this.incidents.reportFailure({
          key: `EVALUATION:${symbol}`,
          type: 'EVALUATION_ERROR',
          component: 'Ciclo de avaliação',
          error: err,
          symbol,
        });
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
