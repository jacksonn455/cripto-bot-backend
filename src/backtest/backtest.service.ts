import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { riskConfig, trendRegimeConfig } from '../config/configuration';
import { EXCHANGE_GATEWAY } from '../exchange/exchange-gateway.interface';
import type { ExchangeGateway } from '../exchange/exchange-gateway.interface';
import { FundingHistoryService } from '../funding/funding-history.service';
import { HistoricalCandlesService } from '../market-data/historical-candles.service';
import { intervalToMs } from '../market-data/interval.util';
import { computeMetrics, MetricsSummary } from '../reports/metrics.util';
import {
  computeRiskAdjusted,
  DAYS_PER_YEAR,
  deflatedSharpe,
  harveyLiuHaircut,
  RiskAdjustedMetrics,
} from '../reports/risk-adjusted.util';
import { variance } from '../reports/stats.util';
import { EquitySnapshotsService } from '../reports/equity-snapshots.service';
import { RiskManagerService } from '../risk/risk-manager.service';
import { SignalsService } from '../risk/signals.service';
import { StrategyRegistryService } from '../strategy/strategy-registry.service';
import { effectiveStrategyParams, StrategyParamsError, type Strategy } from '../strategy/strategy.interface';
import { TradesService } from '../trades/trades.service';
import {
  compareRuns,
  PboInputError,
  PboResult,
  probabilityOfBacktestOverfitting,
  RunComparison,
  RunForAnalysis,
} from './backtest-analysis.util';
import { BacktestRunner } from './backtest-runner';
import { BacktestParams, BacktestResult, EquityPoint, FundingEvent, SimulatedTrade, SymbolSeries } from './backtest.types';
import { RunBacktestDto } from './dto/run-backtest.dto';
import { mergeEquityCurves } from './equity-merge.util';
import { computeParamsHash } from './params-hash.util';
import { BacktestRun, BacktestRunDocument } from './schemas/backtest-run.schema';

export interface WalkForwardWindowResult {
  from: string;
  to: string;
  summary: MetricsSummary;
  tradeCount: number;
  /** Balance at the window start (all symbols), and the window's totalPnl as a fraction of it. */
  startBalance: number;
  returnPct: number;
}

export interface BacktestRunResponse {
  runId: string;
  summary: MetricsSummary;
  tradeCount: number;
  costs: NonNullable<BacktestRun['costs']>;
  /** Fraction of the simulated candles with an open position (0–1). */
  exposurePct: number;
  /** Daily/annualized metrics from the equity curve; null with fewer than 3 days. */
  riskAdjusted: RiskAdjustedMetrics | null;
  /** Consecutive-stops pauses (each lifted at the next UTC day). */
  stopPauses: number;
  engineVersion: number;
  paramVariationsTestedForStrategy: number;
  walkForwardWindows?: WalkForwardWindowResult[];
}

/**
 * Multiple-testing view of a run, computed when it is read (the number of tries keeps growing):
 * how much of its Sharpe survives the variations already tested for the strategy.
 */
export interface RunOverfitting {
  /** Distinct parameter combinations tested for the strategy (the N of the DSR). */
  trials: number;
  /** How many of them have a daily Sharpe stored (runs saved before it existed don't). */
  trialsWithSharpe: number;
  /** Variance of the daily Sharpe across those trials; null with fewer than 2. */
  sharpeVariance: number | null;
  /** Sharpe the best of N tries would reach by luck alone (annualized); null without a variance. */
  expectedMaxSharpeAnnualized: number | null;
  /**
   * Probability that the true Sharpe beats that luck benchmark (Bailey & López de Prado 2014).
   * Accept a variant only at >= 0.95. With a single trial it equals the PSR. null when it can't be
   * estimated (several trials but fewer than 2 with a stored Sharpe).
   */
  deflatedSharpe: number | null;
  /** Harvey & Liu (Bonferroni): the annualized Sharpe after the multiple-testing haircut. */
  haircutSharpe: number;
  /** Fraction of the Sharpe discounted (0.4 = 40%). */
  haircut: number;
}

export type BacktestRunWithVariations = BacktestRun & {
  paramVariationsTestedForStrategy: number;
  overfitting?: RunOverfitting;
};

/**
 * v2: stops gapped through fill at the candle open (was: at the stop price), and the
 * consecutive-stops pause lasts until the next UTC day (was: until the end of the window, since
 * nothing ever reset it).
 */
export const BACKTEST_ENGINE_VERSION = 2;

/** Extra candles the live loop fetches beyond the regime EMA period (see ExecutionService.runCycle). */
const LIVE_LOOKBACK_MARGIN = 10;
const MAX_SYMBOLS = 10;
export const MAX_PBO_RUNS = 20;

export interface TrialStats {
  trials: number;
  sharpes: number[];
}

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
    private readonly fundingHistory: FundingHistoryService,
    @InjectModel(BacktestRun.name) private readonly runModel: Model<BacktestRunDocument>,
    @Inject(EXCHANGE_GATEWAY) private readonly exchange: ExchangeGateway,
    @Inject(trendRegimeConfig.KEY) private readonly trendRegime: ReturnType<typeof trendRegimeConfig>,
    @Inject(riskConfig.KEY) private readonly risk: ReturnType<typeof riskConfig>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Simulates the strategy over [from, to] the way the live loop sees the market:
   *  - each step sees the same number of candles the live loop fetches (regime EMA + margin), with
   *    warm-up history loaded before `from`, so indicators are ready from the first day;
   *  - the regime filter uses its own timeframe (default: the live TREND_REGIME_TIMEFRAME), with
   *    only the regime candles already closed at that point (no lookahead);
   *  - default: several symbols split the initial balance equally, each simulated on its own
   *    (fixed allocation, no shared margin); the run reports all trades and the summed equity curve;
   *  - portfolioMode: all symbols share one balance on a common clock (see BacktestRunner.runPortfolio);
   *  - walk-forward windows chain the balance(s), so the curve is continuous.
   */
  async run(dto: RunBacktestDto): Promise<BacktestRunResponse> {
    const runId = `bt_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const fromMs = new Date(dto.from).getTime();
    const toMs = new Date(dto.to).getTime();
    if (fromMs >= toMs) throw new BadRequestException(['from must be before to']);
    const portfolio = dto.portfolioMode === true;
    if (dto.maxSameSideRiskPct !== undefined && !portfolio) {
      throw new BadRequestException([
        'maxSameSideRiskPct needs portfolioMode: true (the cap only binds when the symbols share one balance)',
      ]);
    }
    const symbols = this.resolveSymbols(dto);

    const strategy = this.resolveStrategy(dto);
    const strategyParams = strategy.getParams?.() ?? {};
    const shortsOn = strategyParams.allowShort === 1;
    const regimeTimeframe = dto.regimeTimeframe ?? this.trendRegime.regimeTimeframe;
    const separateRegime = regimeTimeframe !== dto.timeframe;
    const lookback = (strategyParams.emaRegime ?? this.trendRegime.emaRegime) + LIVE_LOOKBACK_MARGIN;
    const allocation = dto.initialBalance / symbols.length;
    // Equal to slippagePct behaves exactly like omitting it, so it isn't a new variation either.
    const stopSlippagePct =
      dto.stopSlippagePct !== undefined && dto.stopSlippagePct !== dto.slippagePct ? dto.stopSlippagePct : undefined;
    const useFunding = shortsOn && dto.shortCarryModel === 'funding';
    const filters = new Map(
      await Promise.all(symbols.map(async (s) => [s, await this.tryGetSymbolFilters(s)] as const)),
    );
    const funding = useFunding ? await this.loadFunding(symbols, fromMs, toMs) : new Map<string, FundingEvent[]>();

    const windows = dto.walkForward
      ? this.splitWindows(fromMs, toMs, dto.walkForward.testWindowDays)
      : [{ from: fromMs, to: toMs }];

    const baseParams: Omit<BacktestParams, 'symbol' | 'initialBalance' | 'tradeFrom'> = {
      strategy: dto.strategy,
      feesPct: dto.feesPct,
      slippagePct: dto.slippagePct,
      stopSlippagePct,
      shortBorrowPctPerDay: dto.shortBorrowPctPerDay,
      maxSameSideRiskPct: dto.maxSameSideRiskPct,
      candleLookback: lookback,
      regimeLookback: dto.regimeLookback,
    };

    // Fixed allocation: one balance/curve per symbol. Portfolio: a single shared one ('*').
    const books = portfolio ? ['*'] : symbols;
    const startingCapital = portfolio ? dto.initialBalance : allocation;
    const balances = new Map(books.map((b) => [b, startingCapital]));
    const curves = new Map<string, EquityPoint[]>(books.map((b) => [b, []]));
    const allTrades: SimulatedTrade[] = [];
    let stopPauses = 0;
    // First/last traded-period prices per symbol, for the buy-and-hold comparison.
    const prices = new Map<string, { start?: number; end?: number }>(symbols.map((s) => [s, {}]));
    const walkForwardWindows: WalkForwardWindowResult[] = [];

    for (const window of windows) {
      const windowStart = [...balances.values()].reduce((a, b) => a + b, 0);
      const windowTrades: SimulatedTrade[] = [];
      const series: SymbolSeries[] = [];
      for (const symbol of symbols) {
        const s = await this.loadSeries(symbol, dto.timeframe, regimeTimeframe, separateRegime, window, lookback, dto.regimeLookback ?? lookback);
        series.push({ ...s, symbolFilters: filters.get(symbol), fundingEvents: funding.get(symbol) });
        const traded = s.candles.filter((cd) => cd.isClosed && cd.closeTime >= window.from);
        const p = prices.get(symbol)!;
        if (p.start === undefined && traded.length) p.start = traded[0].close;
        if (traded.length) p.end = traded[traded.length - 1].close;
      }

      const groups = portfolio ? [{ book: '*', series }] : series.map((s) => ({ book: s.symbol, series: [s] }));
      for (const { book, series: group } of groups) {
        const params: BacktestParams = {
          ...baseParams,
          symbol: group[0].symbol,
          initialBalance: balances.get(book)!,
          symbolFilters: group[0].symbolFilters,
          tradeFrom: window.from,
        };
        const result = new BacktestRunner(strategy, this.riskManager, params).runPortfolio(group);
        await this.persistTradesAndSignals(result, runId, dto.strategy, dto.timeframe);
        balances.set(book, result.finalBalance);
        curves.get(book)!.push(...result.equityCurve);
        windowTrades.push(...result.trades);
        stopPauses += result.stopPauses;
      }
      allTrades.push(...windowTrades);
      if (dto.walkForward) {
        const summary = computeMetrics(windowTrades, windowStart);
        walkForwardWindows.push({
          from: new Date(window.from).toISOString(),
          to: new Date(window.to).toISOString(),
          summary,
          tradeCount: windowTrades.length,
          startBalance: windowStart,
          returnPct: windowStart ? summary.totalPnl / windowStart : 0,
        });
      }
    }

    const portfolioCurve = mergeEquityCurves(
      books.map((b) => curves.get(b)!),
      books.map(() => startingCapital),
    );
    await this.persistEquity(portfolioCurve, runId);

    const summary = computeMetrics(allTrades, dto.initialBalance);
    const riskAdjusted = computeRiskAdjusted(portfolioCurve, dto.initialBalance);
    const benchmark = buildBenchmark(prices);
    const costs = this.buildCosts(allTrades, dto, {
      stopSlippagePct,
      useFunding,
      fundingFallbackSymbols: useFunding ? symbols.filter((s) => !funding.has(s)) : [],
    });
    const allPoints = [...curves.values()].flat();
    const exposurePct = allPoints.length
      ? allPoints.filter((p) => p.openPositions > 0).length / allPoints.length
      : 0;

    const paramsForHash = {
      strategy: dto.strategy,
      symbols: [...symbols].sort(),
      timeframe: dto.timeframe,
      regimeTimeframe,
      feesPct: dto.feesPct,
      slippagePct: dto.slippagePct,
      // Knobs added later only enter the hash when used, so runs that don't use them keep hashing
      // exactly as before and the overfitting counter doesn't count them twice.
      ...(stopSlippagePct !== undefined ? { stopSlippagePct } : {}),
      // The short carry only matters when shorts are on.
      ...(shortsOn ? (useFunding ? { shortCarryModel: 'funding' } : { shortBorrowPctPerDay: dto.shortBorrowPctPerDay }) : {}),
      ...(portfolio ? { portfolioMode: true } : {}),
      ...(dto.regimeLookback !== undefined && dto.regimeLookback !== lookback ? { regimeLookback: dto.regimeLookback } : {}),
      ...(dto.maxSameSideRiskPct !== undefined ? { maxSameSideRiskPct: dto.maxSameSideRiskPct } : {}),
      initialBalance: dto.initialBalance,
      // Effective values (defaults + overrides) without the knobs that are off, so an explicit
      // default hashes like an omitted one.
      strategyParams: effectiveStrategyParams(strategy.paramSpec ?? [], strategyParams),
    };
    const paramsHash = computeParamsHash(paramsForHash);

    await this.runModel.create({
      runId,
      strategy: dto.strategy,
      params: {
        ...paramsForHash,
        candleLookback: lookback,
        ...(portfolio ? {} : { allocationPerSymbol: allocation }),
        // Not part of the hash (account config, not a strategy choice), but needed to read the
        // Kelly diagnostic against it.
        riskPerTradePct: this.risk.riskPerTradePct,
      },
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
      exposurePct,
      riskAdjusted: (riskAdjusted ?? undefined) as unknown as Record<string, unknown> | undefined,
      stopPauses,
      engineVersion: BACKTEST_ENGINE_VERSION,
    });

    const paramVariationsTestedForStrategy = (await this.trialStats()).get(dto.strategy)?.trials ?? 1;
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
      costs,
      exposurePct,
      riskAdjusted,
      stopPauses,
      engineVersion: BACKTEST_ENGINE_VERSION,
      paramVariationsTestedForStrategy,
      walkForwardWindows: dto.walkForward ? walkForwardWindows : undefined,
    };
  }

  /**
   * Every run carries how many distinct parameter combinations were already tested for its
   * strategy — the dashboard's overfitting warning — and its Sharpe deflated by that number.
   * The more variations tried, the more likely the best one just fits noise in the historical data.
   */
  async listRuns(opts: { strategy?: string; page: number; limit: number }): Promise<{
    items: BacktestRunWithVariations[];
    total: number;
    page: number;
    limit: number;
  }> {
    const filter = opts.strategy ? { strategy: opts.strategy } : {};
    const [runs, total, stats] = await Promise.all([
      this.runModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((opts.page - 1) * opts.limit)
        .limit(opts.limit)
        .lean(),
      this.runModel.countDocuments(filter),
      this.trialStats(),
    ]);
    return {
      items: runs.map((r) => withOverfitting(r, stats.get(r.strategy))),
      total,
      page: opts.page,
      limit: opts.limit,
    };
  }

  async getRun(runId: string): Promise<BacktestRunWithVariations | null> {
    const run = await this.runModel.findOne({ runId }).lean();
    if (!run) return null;
    return withOverfitting(run, (await this.trialStats()).get(run.strategy));
  }

  /** Baseline vs variant, window by window (both must exist; 404 otherwise). */
  async compare(baselineRunId: string, variantRunId: string): Promise<RunComparison> {
    const [baseline, variant] = await Promise.all([
      this.runModel.findOne({ runId: baselineRunId }).lean(),
      this.runModel.findOne({ runId: variantRunId }).lean(),
    ]);
    const missing = [baseline ? null : baselineRunId, variant ? null : variantRunId].filter(Boolean);
    if (missing.length) throw new NotFoundException(`Backtest run(s) not found: ${missing.join(', ')}`);
    return compareRuns(asAnalysisRun(baseline!), asAnalysisRun(variant!));
  }

  /** PBO over 2–20 variants that share the same walk-forward windows. */
  async pbo(runIds: string[]): Promise<PboResult> {
    const ids = [...new Set(runIds)];
    if (ids.length < 2 || ids.length > MAX_PBO_RUNS) {
      throw new BadRequestException([`between 2 and ${MAX_PBO_RUNS} distinct runIds are needed`]);
    }
    const runs = await this.runModel.find({ runId: { $in: ids } }).lean();
    const missing = ids.filter((id) => !runs.some((r) => r.runId === id));
    if (missing.length) throw new NotFoundException(`Backtest run(s) not found: ${missing.join(', ')}`);
    const ordered = ids.map((id) => runs.find((r) => r.runId === id)!);
    try {
      return probabilityOfBacktestOverfitting(ordered.map(asAnalysisRun));
    } catch (err) {
      if (err instanceof PboInputError) throw new BadRequestException(err.problems);
      throw err;
    }
  }

  /**
   * Per strategy: distinct params hashes (the number of tries) and the latest daily Sharpe stored
   * for each, which gives the variance the Deflated Sharpe needs.
   */
  private async trialStats(): Promise<Map<string, TrialStats>> {
    const rows = await this.runModel.aggregate<{ _id: string; trials: number; sharpes: Array<number | null> }>([
      { $sort: { createdAt: 1 } },
      { $group: { _id: { strategy: '$strategy', hash: '$paramsHash' }, sharpe: { $last: '$riskAdjusted.sharpeDaily' } } },
      { $group: { _id: '$_id.strategy', trials: { $sum: 1 }, sharpes: { $push: '$sharpe' } } },
    ]);
    return new Map(
      rows.map((r) => [r._id, { trials: r.trials, sharpes: r.sharpes.filter((v): v is number => typeof v === 'number') }]),
    );
  }

  private async loadSeries(
    symbol: string,
    timeframe: string,
    regimeTimeframe: string,
    separateRegime: boolean,
    window: { from: number; to: number },
    lookback: number,
    regimeLookback: number,
  ): Promise<Pick<SymbolSeries, 'symbol' | 'candles' | 'regimeCandles'>> {
    const candles = await this.historicalCandles.getRange(
      symbol,
      timeframe,
      window.from - lookback * intervalToMs(timeframe),
      window.to,
    );
    const regimeCandles = separateRegime
      ? await this.historicalCandles.getRange(
          symbol,
          regimeTimeframe,
          window.from - regimeLookback * intervalToMs(regimeTimeframe),
          window.to,
        )
      : undefined;
    return { symbol, candles, regimeCandles };
  }

  /** Real funding history per symbol; symbols without it (no perpetual, network) are left out. */
  private async loadFunding(symbols: string[], fromMs: number, toMs: number): Promise<Map<string, FundingEvent[]>> {
    const result = new Map<string, FundingEvent[]>();
    for (const symbol of symbols) {
      try {
        const events = await this.fundingHistory.getRange(symbol, fromMs, toMs);
        if (events.length) result.set(symbol, events);
      } catch (err) {
        this.logger.warn(`No funding history for ${symbol}, charging the fixed short carry instead: ${(err as Error).message}`);
      }
    }
    return result;
  }

  private buildCosts(
    trades: SimulatedTrade[],
    dto: RunBacktestDto,
    extra: { stopSlippagePct?: number; useFunding: boolean; fundingFallbackSymbols: string[] },
  ): NonNullable<BacktestRun['costs']> {
    const total = (f: (t: SimulatedTrade) => number) => trades.reduce((sum, t) => sum + f(t), 0);
    const totalFees = total((t) => t.fees);
    const totalSlippage = total((t) => t.slippageCost);
    return {
      totalFees,
      feesPctOfCapital: dto.initialBalance ? totalFees / dto.initialBalance : 0,
      totalSlippage,
      slippagePctOfCapital: dto.initialBalance ? totalSlippage / dto.initialBalance : 0,
      totalShortCarry: total((t) => t.carryCost),
      shortBorrowPctPerDay: dto.shortBorrowPctPerDay,
      totalGapCost: total((t) => t.gapCost),
      gappedStops: trades.filter((t) => t.gapCost > 0).length,
      ...(extra.stopSlippagePct !== undefined ? { stopSlippagePct: extra.stopSlippagePct } : {}),
      shortCarryModel: extra.useFunding ? 'funding' : 'fixed',
      ...(extra.fundingFallbackSymbols.length ? { fundingFallbackSymbols: extra.fundingFallbackSymbols } : {}),
    };
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

  private async persistTradesAndSignals(
    result: BacktestResult,
    runId: string,
    strategy: string,
    timeframe: string,
  ): Promise<void> {
    await this.tradesService.insertMany(
      result.trades.map((t) => ({
        symbol: t.symbol,
        side: t.side,
        strategy,
        timeframe,
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

/** Adds the multiple-testing view (DSR, haircut) to a stored run. */
export function withOverfitting(run: BacktestRun, stats: TrialStats | undefined): BacktestRunWithVariations {
  const trials = stats?.trials ?? 1;
  const base = { ...run, paramVariationsTestedForStrategy: trials };
  const ra = run.riskAdjusted as unknown as RiskAdjustedMetrics | undefined;
  if (!ra || typeof ra.sharpeDaily !== 'number') return base;
  const sharpes = stats?.sharpes ?? [];
  const sharpeVariance = sharpes.length >= 2 ? variance(sharpes) : null;
  let deflated: number | null = null;
  let expectedMax: number | null = null;
  if (trials <= 1) {
    deflated = ra.probabilisticSharpe;
    expectedMax = 0;
  } else if (sharpeVariance !== null) {
    const d = deflatedSharpe(ra, trials, sharpeVariance);
    deflated = d.deflatedSharpe;
    expectedMax = d.expectedMaxSharpeDaily * Math.sqrt(DAYS_PER_YEAR);
  }
  const { haircutSharpe, haircut } = harveyLiuHaircut(ra.sharpeAnnualized, ra.days, trials);
  return {
    ...base,
    overfitting: {
      trials,
      trialsWithSharpe: sharpes.length,
      sharpeVariance,
      expectedMaxSharpeAnnualized: expectedMax,
      deflatedSharpe: deflated,
      haircutSharpe,
      haircut,
    },
  };
}

function asAnalysisRun(run: BacktestRun): RunForAnalysis {
  return {
    runId: run.runId,
    strategy: run.strategy,
    symbols: run.symbols,
    timeframe: run.timeframe,
    from: run.from,
    to: run.to,
    engineVersion: run.engineVersion,
    params: run.params,
    summary: run.summary as unknown as MetricsSummary,
    walkForwardWindows: run.walkForwardWindows as unknown as RunForAnalysis['walkForwardWindows'],
  };
}
