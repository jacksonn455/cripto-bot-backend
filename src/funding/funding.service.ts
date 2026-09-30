import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { fundingConfig, trendRegimeConfig } from '../config/configuration';
import { FundingRateClient } from './funding-rate.client';
import { FundingRate, FundingRateDocument } from './schemas/funding-rate.schema';

export interface FundingRanking {
  symbol: string;
  /** Fraction per 8h funding interval. */
  rate: number;
  annualizedRatePct: number;
  nextFundingTime: Date;
  timestamp: Date;
}

/** Whole-scan numbers for the dashboard's "market thermometer" (independent of search/paging). */
export interface FundingScanStats {
  count: number;
  positive: number;
  negative: number;
  zero: number;
  medianAnnualizedPct: number;
  averageAnnualizedPct: number;
  /** |annualized| >= EXTREME_ANNUALIZED_PCT. */
  extremeCount: number;
  extremeThresholdPct: number;
  /** Binance's default rate when the market is balanced (interest component), per 8h. */
  baselineRate: number;
}

export interface FundingPage {
  items: FundingRanking[];
  /** Matches after `search`, before paging. */
  total: number;
  page: number;
  limit: number;
  /** When the latest scan ran (null before the first scan). */
  scannedAt: Date | null;
  stats: FundingScanStats | null;
  /** The symbols the bot trades, as perpetuals (their funding is market context for the bot). */
  watch: FundingRanking[];
}

const FUNDINGS_PER_YEAR = 3 * 365; // Binance perpetuals settle funding every 8h.
const EXTREME_ANNUALIZED_PCT = 50;
const BASELINE_RATE = 0.0001; // 0.01% per 8h

export const FUNDING_ORDERS = ['desc', 'asc', 'abs'] as const;
export type FundingOrder = (typeof FUNDING_ORDERS)[number];

/** Read-only: only ever writes to `funding_rates`, never places orders. */
@Injectable()
export class FundingService implements OnModuleInit {
  private readonly logger = new Logger(FundingService.name);
  private readonly client: FundingRateClient;
  /** The latest scan (~1k rows) is kept in memory until a newer scan exists. */
  private cachedScan?: { at: number; rows: FundingRanking[]; stats: FundingScanStats };

  constructor(
    @InjectModel(FundingRate.name) private readonly fundingRateModel: Model<FundingRateDocument>,
    @Inject(fundingConfig.KEY) private readonly config: ReturnType<typeof fundingConfig>,
    @Inject(trendRegimeConfig.KEY) private readonly trendRegime?: ReturnType<typeof trendRegimeConfig>,
  ) {
    this.client = new FundingRateClient(this.config.baseUrl);
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.log('FUNDING_SCAN_ENABLED=false - funding scanner is off');
      return;
    }
    await this.scan();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scan(): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const entries = await this.client.getPremiumIndex();
      const now = new Date();
      await this.fundingRateModel.insertMany(
        entries.map((entry) => ({
          symbol: entry.symbol,
          exchange: 'BINANCE',
          rate: entry.lastFundingRate,
          nextFundingTime: new Date(entry.nextFundingTime),
          timestamp: now,
        })),
      );
      this.logger.log(`Funding scan: recorded rates for ${entries.length} symbols`);
    } catch (err) {
      this.logger.error(`Funding scan failed: ${(err as Error).message}`);
    }
  }

  /**
   * One page of the latest scan, searched (symbol substring) and ordered, plus stats of the whole
   * scan and the bot's own symbols. Every symbol of one scan shares the same `timestamp`.
   */
  async getPage(opts: { page: number; limit: number; search?: string; order?: FundingOrder }): Promise<FundingPage> {
    const scan = await this.latestScan();
    const empty = { items: [], total: 0, page: opts.page, limit: opts.limit, scannedAt: null, stats: null, watch: [] };
    if (!scan) return empty;

    const needle = opts.search?.toUpperCase();
    const filtered = needle ? scan.rows.filter((r) => r.symbol.includes(needle)) : [...scan.rows];
    const order = opts.order ?? 'desc';
    filtered.sort((a, b) => {
      const diff =
        order === 'abs'
          ? Math.abs(b.rate) - Math.abs(a.rate)
          : order === 'asc'
            ? a.annualizedRatePct - b.annualizedRatePct
            : b.annualizedRatePct - a.annualizedRatePct;
      return diff || a.symbol.localeCompare(b.symbol);
    });

    const start = (opts.page - 1) * opts.limit;
    const watchSymbols = new Set(this.trendRegime?.symbols ?? []);
    return {
      items: filtered.slice(start, start + opts.limit),
      total: filtered.length,
      page: opts.page,
      limit: opts.limit,
      scannedAt: new Date(scan.at),
      stats: scan.stats,
      watch: scan.rows.filter((r) => watchSymbols.has(r.symbol)),
    };
  }

  private async latestScan(): Promise<{ at: number; rows: FundingRanking[]; stats: FundingScanStats } | null> {
    const latest = await this.fundingRateModel.findOne({}, { timestamp: 1 }).sort({ timestamp: -1 }).lean();
    if (!latest) return null;
    const at = latest.timestamp.getTime();
    if (this.cachedScan?.at === at) return this.cachedScan;

    const docs = await this.fundingRateModel
      .find({ timestamp: latest.timestamp }, { _id: 0, symbol: 1, rate: 1, nextFundingTime: 1, timestamp: 1 })
      .lean();
    const rows: FundingRanking[] = docs.map((d) => ({
      symbol: d.symbol,
      rate: d.rate,
      annualizedRatePct: d.rate * FUNDINGS_PER_YEAR * 100,
      nextFundingTime: d.nextFundingTime,
      timestamp: d.timestamp,
    }));
    this.cachedScan = { at, rows, stats: computeStats(rows) };
    return this.cachedScan;
  }
}

export function computeStats(rows: FundingRanking[]): FundingScanStats {
  const annual = rows.map((r) => r.annualizedRatePct).sort((a, b) => a - b);
  const n = annual.length;
  const median = n === 0 ? 0 : n % 2 ? annual[(n - 1) / 2] : (annual[n / 2 - 1] + annual[n / 2]) / 2;
  return {
    count: n,
    positive: rows.filter((r) => r.rate > 0).length,
    negative: rows.filter((r) => r.rate < 0).length,
    zero: rows.filter((r) => r.rate === 0).length,
    medianAnnualizedPct: median,
    averageAnnualizedPct: n ? annual.reduce((s, v) => s + v, 0) / n : 0,
    extremeCount: annual.filter((v) => Math.abs(v) >= EXTREME_ANNUALIZED_PCT).length,
    extremeThresholdPct: EXTREME_ANNUALIZED_PCT,
    baselineRate: BASELINE_RATE,
  };
}
