import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model, PipelineStage } from 'mongoose';
import { RedisCacheService } from '../cache/redis-cache.service';
import { redisConfig } from '../config/configuration';
import { Trade, TradeDocument } from '../trades/schemas/trade.schema';
import { computeMetrics, MetricsSummary } from './metrics.util';
import { GroupedMetric, ModeComparison, ReportsFilter } from './reports.interface';

// Every cached key lives under this prefix so a new trade can invalidate all of them in one SCAN.
const CACHE_PREFIX = 'reports:';

@Injectable()
export class ReportsService {
  constructor(
    @InjectModel(Trade.name) private readonly tradeModel: Model<TradeDocument>,
    private readonly cache: RedisCacheService,
    @Inject(redisConfig.KEY)
    private readonly cacheConfig: ReturnType<typeof redisConfig>,
  ) {}

  // Trades only change via ExecutionService (open/close) — a fresh trade makes every cached
  // report/chart query stale, so we drop the whole namespace rather than track fine-grained keys.
  @OnEvent('trade.opened')
  @OnEvent('trade.closed')
  // Backtests bulk-insert their trades without trade.* events.
  @OnEvent('backtest.completed')
  async invalidateCache(): Promise<void> {
    await this.cache.deleteByPrefix(CACHE_PREFIX);
  }

  async summary(filter: ReportsFilter, initialBalance = 0): Promise<MetricsSummary> {
    const key = `${CACHE_PREFIX}summary:${JSON.stringify(filter)}:${initialBalance}`;
    return this.cache.getOrSet(key, this.cacheConfig.reportsTtlSeconds, async () => {
      const trades = await this.tradeModel.find(this.buildMatch(filter)).lean();
      return computeMetrics(
        trades.map((t) => ({
          pnl: t.pnl ?? 0,
          pnlPct: t.pnlPct ?? 0,
          entryTime: t.entryTime,
          exitTime: t.exitTime ?? t.entryTime,
          exitReason: t.exitReason,
          side: t.side,
          fees: t.fees ?? 0,
        })),
        initialBalance,
      );
    });
  }

  async byStrategy(filter: ReportsFilter, page: number, limit: number): Promise<{ items: GroupedMetric[]; total: number }> {
    const key = `${CACHE_PREFIX}byStrategy:${JSON.stringify(filter)}:${page}:${limit}`;
    return this.cache.getOrSet(key, this.cacheConfig.reportsTtlSeconds, () =>
      this.groupBy('$strategy', filter, page, limit),
    );
  }

  async bySymbol(filter: ReportsFilter, page: number, limit: number): Promise<{ items: GroupedMetric[]; total: number }> {
    const key = `${CACHE_PREFIX}bySymbol:${JSON.stringify(filter)}:${page}:${limit}`;
    return this.cache.getOrSet(key, this.cacheConfig.reportsTtlSeconds, () =>
      this.groupBy('$symbol', filter, page, limit),
    );
  }

  /** LONG vs SHORT side by side (a missing side on legacy trades is not expected: the field is required). */
  async bySide(filter: ReportsFilter, page: number, limit: number): Promise<{ items: GroupedMetric[]; total: number }> {
    const key = `${CACHE_PREFIX}bySide:${JSON.stringify(filter)}:${page}:${limit}`;
    return this.cache.getOrSet(key, this.cacheConfig.reportsTtlSeconds, () =>
      this.groupBy('$side', filter, page, limit),
    );
  }

  /**
   * Buckets by the exit time's hour (0–23) and day of week (1 = Sunday … 7 = Saturday), in the
   * given IANA time zone (default UTC), so "14h" means 14h on the viewer's clock.
   */
  async byHour(
    filter: ReportsFilter,
    timezone = 'UTC',
  ): Promise<{ byHourOfDay: GroupedMetric[]; byDayOfWeek: GroupedMetric[]; timezone: string }> {
    const key = `${CACHE_PREFIX}byHour:${JSON.stringify(filter)}:${timezone}`;
    return this.cache.getOrSet(key, this.cacheConfig.reportsTtlSeconds, async () => {
      const [byHourOfDay, byDayOfWeek] = await Promise.all([
        this.groupByDateExpression({ $hour: { date: '$exitTime', timezone } }, filter),
        this.groupByDateExpression({ $dayOfWeek: { date: '$exitTime', timezone } }, filter),
      ]);
      return { byHourOfDay, byDayOfWeek, timezone };
    });
  }

  /**
   * Full metrics for each mode side by side, so backtest results can be checked against
   * paper/live (slippage, overfitting). BACKTEST covers one run (runId) or all runs, over the
   * run's own historical dates — from/to only apply to PAPER and LIVE, since a date window of
   * "the last 30 days" would otherwise exclude every backtest trade.
   */
  async compareModes(filter: Omit<ReportsFilter, 'mode'>): Promise<ModeComparison[]> {
    const key = `${CACHE_PREFIX}compareModes:${JSON.stringify(filter)}`;
    return this.cache.getOrSet(key, this.cacheConfig.reportsTtlSeconds, async () => {
      const { runId, from, to, dateField, ...common } = filter;
      const [backtest, paper, live] = await Promise.all([
        this.summary({ ...common, mode: 'BACKTEST', runId }),
        this.summary({ ...common, mode: 'PAPER', from, to, dateField }),
        this.summary({ ...common, mode: 'LIVE', from, to, dateField }),
      ]);
      return [
        { mode: 'BACKTEST', runId: runId ?? null, summary: backtest },
        { mode: 'PAPER', runId: null, summary: paper },
        { mode: 'LIVE', runId: null, summary: live },
      ];
    });
  }

  private async groupBy(
    field: string,
    filter: ReportsFilter,
    page: number,
    limit: number,
  ): Promise<{ items: GroupedMetric[]; total: number }> {
    const pipeline: PipelineStage[] = [
      { $match: this.buildMatch(filter) },
      ...this.groupStages(field),
      {
        $facet: {
          items: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await this.tradeModel.aggregate(pipeline);
    return {
      items: (result?.items ?? []) as GroupedMetric[],
      total: result?.total?.[0]?.count ?? 0,
    };
  }

  private async groupByDateExpression(
    dateExpr: Record<string, unknown>,
    filter: ReportsFilter,
  ): Promise<GroupedMetric[]> {
    const pipeline: PipelineStage[] = [
      { $match: this.buildMatch(filter) },
      { $addFields: { __bucket: dateExpr } },
      ...this.groupStages('$__bucket'),
    ];
    const results = (await this.tradeModel.aggregate(pipeline)) as GroupedMetric[];
    // `key` is stringified, so sort numerically here ("2" before "10").
    return results.sort((a, b) => Number(a.key) - Number(b.key));
  }

  private groupStages(idField: string): PipelineStage[] {
    return [
      {
        $group: {
          _id: idField,
          tradeCount: { $sum: 1 },
          totalPnl: { $sum: '$pnl' },
          winCount: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, 1, 0] } },
          grossProfit: { $sum: { $cond: [{ $gt: ['$pnl', 0] }, '$pnl', 0] } },
          grossLoss: { $sum: { $cond: [{ $lte: ['$pnl', 0] }, { $abs: '$pnl' }, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          key: { $toString: '$_id' },
          tradeCount: 1,
          totalPnl: 1,
          winRate: {
            $cond: [{ $eq: ['$tradeCount', 0] }, 0, { $divide: ['$winCount', '$tradeCount'] }],
          },
          profitFactor: {
            $cond: [{ $eq: ['$grossLoss', 0] }, 0, { $divide: ['$grossProfit', '$grossLoss'] }],
          },
        },
      },
      { $sort: { totalPnl: -1 } },
    ];
  }

  private buildMatch(filter: ReportsFilter): Record<string, unknown> {
    const match: Record<string, unknown> = { status: 'CLOSED' };
    if (filter.mode) match.mode = filter.mode;
    if (filter.symbol) match.symbol = filter.symbol.toUpperCase();
    if (filter.strategy) match.strategy = filter.strategy;
    if (filter.side) match.side = filter.side;
    if (filter.runId) match.runId = filter.runId;
    if (filter.from || filter.to) {
      match[filter.dateField ?? 'entryTime'] = {
        ...(filter.from ? { $gte: new Date(filter.from) } : {}),
        ...(filter.to ? { $lte: new Date(filter.to) } : {}),
      };
    }
    return match;
  }
}
