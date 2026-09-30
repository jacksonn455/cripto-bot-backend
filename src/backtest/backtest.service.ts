import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { trendRegimeConfig } from '../config/configuration';
import { EXCHANGE_GATEWAY } from '../exchange/exchange-gateway.interface';
import type { ExchangeGateway } from '../exchange/exchange-gateway.interface';
import { HistoricalCandlesService } from '../market-data/historical-candles.service';
import { intervalToMs } from '../market-data/interval.util';
import { computeMetrics, MetricsSummary } from '../reports/metrics.util';
import { EquitySnapshotsService } from '../reports/equity-snapshots.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { SignalsService } from '../risk/signals.service';
import { StrategyRegistryService } from '../strategy/strategy-registry.service';
import { StrategyParamsError, type Strategy } from '../strategy/strategy.interface';
import { TradesService } from '../trades/trades.service';
import { BacktestRunner } from './backtest-runner';
import { BacktestParams, BacktestResult, EquityPoint, SimulatedTrade } from './backtest.types';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { mergeEquityCurves } from './equity-merge.util';
import { computeParamsHash } from './params-hash.util';
import { BacktestRun, BacktestRunDocument } from './schemas/backtest-run.schema';

export interface BacktestRunResponse {
  runId: string;
  summary: MetricsSummary;
  tradeCount: number;
  paramVariationsTestedForStrategy: number;
  walkForwardWindows?: Array<{ from: string; to: string; summary: MetricsSummary; tradeCount: number }>;
}

export type BacktestRunWithVariations = BacktestRun & { paramVariationsTestedForStrategy: number };

/** Extra candles the live loop fetches beyond the regime EMA period (see ExecutionService.runCycle). */
const LIVE_LOOKBACK_MARGIN = 10;
const MAX_SYMBOLS = 10;

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    private readonly historicalCandles: HistoricalCandlesService,
    private readonly strategyRegistry: StrategyRegistryService,
    private readonly riskManager: RiskManagerService,
    private readonly tradesService: TradesService,
    private readonly signalsService: SignalsService,
    private readonly equitySnapshots: EquitySnapshotsService,
    @InjectModel(BacktestRun.name) private readonly runModel: Model<BacktestRunDocument>,
    @Inject(EXCHANGE_GATEWAY) private readonly exchange: ExchangeGateway,
    @Inject(trendRegimeConfig.KEY) private readonly trendRegime: ReturnType<typeof trendRegimeConfig>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Simulates the strategy over [from, to] the way the live loop sees the market:
   *  - each step sees the same number of candles the live loop fetches (regime EMA + margin), with
   *    warm-up history loaded before `from`, so indicators are ready from the first day;
   *  - the regime filter uses its own timeframe (default: the live TREND_REGIME_TIMEFRAME), with
   *    only the regime candles already closed at that point (no lookahead);
   *  - several symbols split the initial balance equally, each simulated on its own (fixed
   *    allocation, no shared margin); the run reports all trades and the summed equity curve;
   *  - walk-forward windows chain each symbol's balance, so the curve is continuous.
   */
  async run(dto: RunBacktestDto): Promise<BacktestRunResponse> {
    const runId = `bt_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const fromMs = new Date(dto.from).getTime();
    const toMs = new Date(dto.to).getTime();
    if (fromMs >= toMs) throw new BadRequestException(['from must be before to']);
    const symbols = this.resolveSymbols(dto);

    const strategy = this.resolveStrategy(dto);
    const strategyParams = strategy.getParams?.() ?? {};
    const regimeTimeframe = dto.regimeTimeframe ?? this.trendRegime.regimeTimeframe;
    const separateRegime = regimeTimeframe !== dto.timeframe;
    const lookback = (strategyParams.emaRegime ?? this.trendRegime.emaRegime) + LIVE_LOOKBACK_MARGIN;
    const allocation = dto.initialBalance / symbols.length;
    const filters = new Map(
      await Promise.all(symbols.map(async (s) => [s, await this.tryGetSymbolFilters(s)] as const)),
    );

    const windows = dto.walkForward
      ? this.splitWindows(fromMs, toMs, dto.walkForward.testWindowDays)
      : [{ from: fromMs, to: toMs }];

    const balances = new Map(symbols.map((s) => [s, allocation]));
    const curves = new Map<string, EquityPoint[]>(symbols.map((s) => [s, []]));
    const allTrades: SimulatedTrade[] = [];
    // First/last traded-period prices per symbol, for the buy-and-hold comparison.
    const prices = new Map<string, { start?: number; end?: number }>(symbols.map((s) => [s, {}]));
    const walkForwardWindows: NonNullable<BacktestRunResponse['walkForwardWindows']> = [];

    for (const window of windows) {
      const windowStart = [...balances.values()].reduce((a, b) => a + b, 0);
      const windowTrades: SimulatedTrade[] = [];
      for (const symbol of symbols) {
        const candles = await this.historicalCandles.getRange(
          symbol,
          dto.timeframe,
          window.from - lookback * intervalToMs(dto.timeframe),
          window.to,
        );
        const regimeCandles = separateRegime
          ? await this.historicalCandles.getRange(
              symbol,
              regimeTimeframe,
              window.from - lookback * intervalToMs(regimeTimeframe),
              window.to,
            )
          : undefined;
        const params: BacktestParams = {
          strategy: dto.strategy,
          symbol,
          initialBalance: balances.get(symbol)!,
          feesPct: dto.feesPct,
          slippagePct: dto.slippagePct,
          symbolFilters: filters.get(symbol),
          candleLookback: lookback,
          tradeFrom: window.from,
        };
        const result = new BacktestRunner(strategy, this.riskManager, params).run(candles, regimeCandles);
        const traded = candles.filter((cd) => cd.isClosed && cd.closeTime >= window.from);
        const p = prices.get(symbol)!;
        if (p.start === undefined && traded.length) p.start = traded[0].close;
        if (traded.length) p.end = traded[traded.length - 1].close;
        await this.persistTradesAndSignals(result, runId, dto.strategy);
        balances.set(symbol, result.finalBalance);
        curves.get(symbol)!.push(...result.equityCurve);
        windowTrades.push(...result.trades);
      }
      allTrades.push(...windowTrades);
      if (dto.walkForward) {
        walkForwardWindows.push({
          from: new Date(window.from).toISOString(),
          to: new Date(window.to).toISOString(),
          summary: computeMetrics(windowTrades, windowStart),
          tradeCount: windowTrades.length,
        });
      }
    }

    await this.persistEquity(
      mergeEquityCurves(
        symbols.map((s) => curves.get(s)!),
        symbols.map(() => allocation),
      ),
      runId,
    );

    const summary = computeMetrics(allTrades, dto.initialBalance);
    const benchmark = buildBenchmark(prices);
    const totalFees = allTrades.reduce((sum, t) => sum + t.fees, 0);
    const costs = { totalFees, feesPctOfCapital: dto.initialBalance ? totalFees / dto.initialBalance : 0 };
    const paramsForHash = {
      strategy: dto.strategy,
      symbols: [...symbols].sort(),
      timeframe: dto.timeframe,
      regimeTimeframe,
      feesPct: dto.feesPct,
      slippagePct: dto.slippagePct,
      initialBalance: dto.initialBalance,
      // Effective values (defaults + overrides), so an explicit default hashes like an omitted one.
      strategyParams,
    };
    const paramsHash = computeParamsHash(paramsForHash);

    await this.runModel.create({
      runId,
      strategy: dto.strategy,
      params: { ...paramsForHash, candleLookback: lookback, allocationPerSymbol: allocation },
      paramsHash,
      symbols,
      timeframe: dto.timeframe,
      from: new Date(dto.from),
      to: new Date(dto.to),
      feesPct: dto.feesPct,
      slippagePct: dto.slippagePct,
      summary: summary as unknown as Record<string, unknown>,
      walkForwardWindows: dto.walkForward
        ? (walkForwardWindows as unknown as Record<string, unknown>[])
        : undefined,
      benchmark,
      costs,
    });

    const paramVariationsTestedForStrategy = (await this.variationsByStrategy()).get(dto.strategy) ?? 1;
    // Backtest trades are bulk-inserted (no trade.* events), so cached reports are dropped here.
    this.eventEmitter.emit('backtest.completed', {
      runId,
      strategy: dto.strategy,
      symbols,
      timeframe: dto.timeframe,
      tradeCount: allTrades.length,
      totalPnl: summary.totalPnl,
    });

    return {
      runId,
      summary,
      tradeCount: allTrades.length,
      paramVariationsTestedForStrategy,
      walkForwardWindows: dto.walkForward ? walkForwardWindows : undefined,
    };
  }

  /**
   * Every run carries how many distinct parameter combinations were already tested for its
   * strategy — the dashboard's overfitting warning. The more variations tried, the more likely
   * the best one just fits noise in the historical data.
   */
  async listRuns(opts: { strategy?: string; page: number; limit: number }): Promise<{
    items: BacktestRunWithVariations[];
    total: number;
    page: number;
    limit: number;
  }> {
    const filter = opts.strategy ? { strategy: opts.strategy } : {};
    const [runs, total, variations] = await Promise.all([
      this.runModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((opts.page - 1) * opts.limit)
        .limit(opts.limit)
        .lean(),
      this.runModel.countDocuments(filter),
      this.variationsByStrategy(),
    ]);
    return {
      items: runs.map((r) => ({ ...r, paramVariationsTestedForStrategy: variations.get(r.strategy) ?? 1 })),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  }

  async getRun(runId: string): Promise<BacktestRunWithVariations | null> {
    const run = await this.runModel.findOne({ runId }).lean();
    if (!run) return null;
    const variations = await this.variationsByStrategy();
    return { ...run, paramVariationsTestedForStrategy: variations.get(run.strategy) ?? 1 };
  }

  private async variationsByStrategy(): Promise<Map<string, number>> {
    const rows = await this.runModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$strategy', hashes: { $addToSet: '$paramsHash' } } },
      { $project: { count: { $size: '$hashes' } } },
    ]);
    return new Map(rows.map((r) => [r._id, r.count]));
  }

  private resolveSymbols(dto: RunBacktestDto): string[] {
    const symbols = [...new Set([...(dto.symbols ?? []), ...(dto.symbol ? [dto.symbol] : [])].map((s) => s.toUpperCase()))];
    if (symbols.length === 0) throw new BadRequestException(['symbol or symbols is required']);
    if (symbols.length > MAX_SYMBOLS) throw new BadRequestException([`at most ${MAX_SYMBOLS} symbols per run`]);
    return symbols;
  }

  /** The registered strategy, or a copy with `strategyParams` applied (never the live instance). */
  private resolveStrategy(dto: RunBacktestDto): Strategy {
    const base = this.strategyRegistry.get(dto.strategy);
    const overrides = dto.strategyParams ?? {};
    if (Object.keys(overrides).length === 0) return base;
    if (!base.withParams) {
      throw new BadRequestException([`${dto.strategy} has no tunable parameters`]);
    }
    try {
      return base.withParams(overrides);
    } catch (err) {
      if (err instanceof StrategyParamsError) {
        throw new BadRequestException(err.problems.map((p) => `strategyParams: ${p}`));
      }
      throw err;
    }
  }

  private async persistTradesAndSignals(result: BacktestResult, runId: string, strategy: string): Promise<void> {
    await this.tradesService.insertMany(
      result.trades.map((t) => ({
        symbol: t.symbol,
        side: t.side,
        strategy,
        mode: 'BACKTEST' as const,
        runId,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        qty: t.qty,
        entryTime: new Date(t.entryTime),
        exitTime: new Date(t.exitTime),
        fees: t.fees,
        pnl: t.pnl,
        pnlPct: t.pnlPct,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        status: 'CLOSED' as const,
        exitReason: t.exitReason,
        maxAdverseExcursion: t.maxAdverseExcursion,
        maxFavorableExcursion: t.maxFavorableExcursion,
      })),
    );
    await this.signalsService.insertMany(result.signals, strategy, 'BACKTEST', runId);
  }

  private async persistEquity(curve: EquityPoint[], runId: string): Promise<void> {
    await this.equitySnapshots.insertMany(
      curve.map((p) => ({
        mode: 'BACKTEST',
        runId,
        timestamp: new Date(p.timestamp),
        balance: p.balance,
        equity: p.equity,
        openPositions: p.openPositions,
      })),
    );
  }

  private splitWindows(fromMs: number, toMs: number, testWindowDays: number) {
    const windowMs = testWindowDays * 86_400_000;
    const windows: Array<{ from: number; to: number }> = [];
    let cursor = fromMs;
    while (cursor < toMs) {
      const windowEnd = Math.min(cursor + windowMs, toMs);
      windows.push({ from: cursor, to: windowEnd });
      cursor = windowEnd;
    }
    return windows;
  }

  private async tryGetSymbolFilters(symbol: string): Promise<BacktestParams['symbolFilters']> {
    try {
      const filters = await this.exchange.getSymbolFilters(symbol);
      return {
        stepSize: filters.stepSize,
        minQty: filters.minQty,
        minNotional: filters.minNotional,
      };
    } catch (err) {
      this.logger.warn(
        `Could not fetch symbol filters for ${symbol}, running without LOT_SIZE/MIN_NOTIONAL checks: ${(err as Error).message}`,
      );
      return undefined;
    }
  }
}

/** Buy-and-hold return per symbol, and combined with the same equal allocation as the run. */
export function buildBenchmark(prices: Map<string, { start?: number; end?: number }>): BacktestRun['benchmark'] {
  const bySymbol: NonNullable<BacktestRun['benchmark']>['bySymbol'] = {};
  for (const [symbol, p] of prices) {
    if (p.start && p.end) {
      bySymbol[symbol] = { startPrice: p.start, endPrice: p.end, returnPct: ((p.end - p.start) / p.start) * 100 };
    }
  }
  const returns = Object.values(bySymbol).map((b) => b.returnPct);
  if (returns.length === 0) return undefined;
  return { bySymbol, buyAndHoldPct: returns.reduce((a, b) => a + b, 0) / returns.length };
}
