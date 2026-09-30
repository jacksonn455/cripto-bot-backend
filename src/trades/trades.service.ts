import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';
import { GetTradesQueryDto } from './dto/get-trades-query.dto';
import { computePnl } from './position-math.util';
import { Trade, TradeDocument, TradeExitReason, TradeMode } from './schemas/trade.schema';
import { buildTradeClosedEvent, TradeClosedEvent } from './trade-events';

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

const CSV_COLUMNS = [
  'symbol', 'side', 'strategy', 'mode', 'runId',
  'entryPrice', 'exitPrice', 'qty', 'entryTime', 'exitTime',
  'fees', 'pnl', 'pnlPct', 'stopLoss', 'takeProfit',
  'status', 'exitReason', 'isSeed', 'timeframe',
] as const;

@Injectable()
export class TradesService {
  constructor(
    @InjectModel(Trade.name) private readonly tradeModel: Model<TradeDocument>,
  ) {}

  async findAll(query: GetTradesQueryDto): Promise<PaginatedResult<Trade>> {
    const filter = this.buildFilter(query);
    const sort: Record<string, 1 | -1> = {
      [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1,
    };

    const [items, total] = await Promise.all([
      this.tradeModel
        .find(filter)
        .sort(sort)
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.tradeModel.countDocuments(filter),
    ]);

    return { items, total, page: query.page, limit: query.limit };
  }

  async findOne(id: string): Promise<Trade> {
    const trade = await this.tradeModel.findById(id).lean();
    if (!trade) {
      throw new NotFoundException(`Trade ${id} not found`);
    }
    return trade;
  }

  async insertMany(trades: Partial<Trade>[]): Promise<void> {
    if (trades.length === 0) return;
    await this.tradeModel.insertMany(trades);
  }

  async findOpenPosition(symbol: string, mode: TradeMode): Promise<TradeDocument | null> {
    return this.tradeModel.findOne({ symbol, mode, status: 'OPEN' });
  }

  async findAllOpen(mode: TradeMode): Promise<TradeDocument[]> {
    return this.tradeModel.find({ mode, status: 'OPEN' });
  }

  async countOpenPositions(mode: TradeMode): Promise<number> {
    return this.tradeModel.countDocuments({ mode, status: 'OPEN' });
  }

  async openPosition(trade: Partial<Trade>): Promise<TradeDocument> {
    return this.tradeModel.create(trade);
  }

  async closePosition(
    id: Types.ObjectId | string,
    data: {
      exitPrice: number;
      exitTime: Date;
      fees: number;
      pnl: number;
      pnlPct: number;
      exitReason: TradeExitReason;
    },
  ): Promise<void> {
    await this.tradeModel.updateOne({ _id: id }, { $set: { ...data, status: 'CLOSED' } });
  }

  /**
   * Closes an open trade with direction-aware pnl (LONG and SHORT) and returns the
   * `trade.closed` event payload for the caller to emit — the single settlement path shared by
   * execution, reconciliation and the kill switch.
   */
  async settlePosition(
    trade: Pick<Trade, 'symbol' | 'side' | 'mode' | 'strategy' | 'timeframe' | 'qty' | 'entryPrice' | 'stopLoss' | 'takeProfit' | 'entryTime' | 'entryReason'> & {
      _id: Types.ObjectId | string;
    },
    close: { exitPrice: number; exitTime: Date; exitReason: TradeExitReason; fees?: number; reasonDetail?: string },
  ): Promise<TradeClosedEvent> {
    const fees = close.fees ?? 0;
    const { pnl, pnlPct } = computePnl(trade.side, trade.entryPrice, close.exitPrice, trade.qty, fees);
    const data = { exitPrice: close.exitPrice, exitTime: close.exitTime, fees, pnl, pnlPct, exitReason: close.exitReason };
    await this.closePosition(trade._id, data);
    return buildTradeClosedEvent(trade, data, close.reasonDetail);
  }

  async exportCsv(query: GetTradesQueryDto): Promise<string> {
    const filter = this.buildFilter(query);
    const trades = await this.tradeModel
      .find(filter)
      .sort({ [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1 })
      .lean();
    return this.toCsv(trades);
  }

  private buildFilter(query: GetTradesQueryDto): QueryFilter<TradeDocument> {
    const filter: QueryFilter<TradeDocument> = {};
    if (query.mode) filter.mode = query.mode;
    if (query.symbol) filter.symbol = query.symbol.toUpperCase();
    if (query.strategy) filter.strategy = query.strategy;
    if (query.side) filter.side = query.side;
    if (query.status) filter.status = query.status;
    if (query.runId) filter.runId = query.runId;
    // Real trades have no isSeed field at all, hence $ne rather than false.
    if (query.isSeed !== undefined) filter.isSeed = query.isSeed ? true : { $ne: true };
    if (query.from || query.to) {
      filter.entryTime = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    }
    return filter;
  }

  private toCsv(trades: Trade[]): string {
    const header = CSV_COLUMNS.join(',');
    const rows = trades.map((trade) =>
      CSV_COLUMNS.map((col) => this.csvCell(trade[col])).join(','),
    );
    return [header, ...rows].join('\n');
  }

  private csvCell(value: string | number | boolean | Date | undefined): string {
    if (value === undefined || value === null) return '';
    const str = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }
}
