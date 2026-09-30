import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter } from 'mongoose';
import type { TradeMode } from '../trades/schemas/trade.schema';
import type { Signal } from '../strategy/strategy.interface';
import type { GetSignalsQueryDto } from './dto/get-signals-query.dto';
import type { RiskDecision } from './risk.interface';
import { SignalDocument, SignalRecord } from './schemas/signal.schema';

export interface SignalsPage {
  items: SignalRecord[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class SignalsService {
  constructor(
    @InjectModel(SignalRecord.name) private readonly signalModel: Model<SignalDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Paper/live: one record per entry signal evaluated by risk (approved or vetoed). */
  async record(
    signal: Signal,
    decision: RiskDecision,
    mode: TradeMode,
    runId?: string,
  ): Promise<void> {
    await this.signalModel.create({
      strategy: signal.strategy,
      symbol: signal.symbol,
      signal: signal.action,
      reason: signal.reason,
      price: signal.price,
      indicators: signal.indicators,
      candleTime: new Date(signal.candleTime),
      approved: decision.approved,
      rejectReason: decision.rejectReason,
      mode,
      runId,
    });
    this.eventEmitter.emit('signal.recorded', {
      symbol: signal.symbol,
      strategy: signal.strategy,
      signal: signal.action,
      reason: signal.reason,
      price: signal.price,
      approved: decision.approved,
      rejectReason: decision.rejectReason ?? null,
      mode,
      candleTime: new Date(signal.candleTime).toISOString(),
    });
  }

  async insertMany(
    records: Array<{
      candleTime: number;
      symbol: string;
      action: string;
      approved: boolean;
      rejectReason?: string;
      indicators: Record<string, number | undefined>;
    }>,
    strategy: string,
    mode: TradeMode,
    runId?: string,
  ): Promise<void> {
    if (records.length === 0) return;
    await this.signalModel.insertMany(
      records.map((r) => ({
        strategy,
        symbol: r.symbol,
        signal: r.action,
        indicators: r.indicators,
        candleTime: new Date(r.candleTime),
        approved: r.approved,
        rejectReason: r.rejectReason,
        mode,
        runId,
      })),
    );
  }

  /** Newest first. */
  async list(query: GetSignalsQueryDto): Promise<SignalsPage> {
    const filter: QueryFilter<SignalDocument> = {};
    if (query.mode) filter.mode = query.mode;
    if (query.symbol) filter.symbol = query.symbol.toUpperCase();
    if (query.strategy) filter.strategy = query.strategy;
    if (query.approved !== undefined) filter.approved = query.approved;
    if (query.runId) filter.runId = query.runId;
    if (query.from || query.to) {
      filter.candleTime = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    }
    const [items, total] = await Promise.all([
      this.signalModel
        .find(filter)
        .sort({ candleTime: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean(),
      this.signalModel.countDocuments(filter),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }
}
