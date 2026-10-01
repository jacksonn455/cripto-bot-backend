import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ControlService } from '../control/control.service';
import { Trade, TradeDocument, TradeMode } from '../trades/schemas/trade.schema';
import { RiskContext } from './risk.interface';
import { countStopStreak } from './stop-streak.util';
import type { ExchangeGateway } from '../exchange/exchange-gateway.interface';
import type { SymbolFilters } from '../exchange/types/symbol-filters.type';

/** Builds a fresh RiskContext from the DB + exchange every time — never trusts cached state. */
@Injectable()
export class RiskContextBuilderService {
  constructor(
    @InjectModel(Trade.name) private readonly tradeModel: Model<TradeDocument>,
    private readonly controlService: ControlService,
  ) {}

  async build(
    gateway: ExchangeGateway,
    symbol: string,
    mode: TradeMode,
    quoteAsset: string,
    reconciliationOk: boolean,
  ): Promise<RiskContext> {
    // bot_state first: the stop streak only counts trades closed after the last manual resume.
    const state = await this.controlService.getState();
    const streakFilter = state.stopStreakResetAt ? { exitTime: { $gt: state.stopStreakResetAt } } : {};
    const [balance, openTrades, todaysClosedTrades, recentClosedTrades, symbolFilters] =
      await Promise.all([
        gateway.getBalance(quoteAsset),
        this.tradeModel.find({ mode, status: 'OPEN' }).lean(),
        this.tradeModel
          .find({ mode, status: 'CLOSED', exitTime: { $gte: this.startOfUtcDay() } })
          .lean(),
        // Newest first; a streak long enough to matter is far shorter than 20.
        this.tradeModel.find({ mode, status: 'CLOSED', ...streakFilter }).sort({ exitTime: -1 }).limit(20).lean(),
        this.tryGetSymbolFilters(gateway, symbol),
      ]);

    const currentExposureByAsset: Record<string, number> = {};
    let totalExposure = 0;
    let shortNotional = 0;
    for (const trade of openTrades) {
      const notional = trade.qty * trade.entryPrice;
      currentExposureByAsset[trade.symbol] = (currentExposureByAsset[trade.symbol] ?? 0) + notional;
      totalExposure += notional;
      if (trade.side === 'SHORT') shortNotional += notional;
    }

    return {
      accountEquity: this.buyingPower(balance?.free ?? 0, shortNotional),
      openPositionsCount: openTrades.length,
      currentExposureByAsset,
      totalExposure,
      dailyPnl: todaysClosedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
      consecutiveStopLosses: countStopStreak([...recentClosedTrades].reverse()),
      isPaused: state.isPaused,
      reconciliationOk,
      symbolFilters,
      shortSellingSupported: gateway.supportsShortSelling === true,
    };
  }

  /**
   * Free quote balance available to size new trades. A long spends its notional (cash goes down);
   * a short *receives* its sale proceeds (cash goes up) while also tying up the same amount as
   * 1:1 collateral. Removing both keeps a short consuming buying power exactly like a long,
   * instead of letting the proceeds inflate the next position size.
   */
  private buyingPower(freeQuote: number, openShortNotional: number): number {
    return Math.max(0, freeQuote - 2 * openShortNotional);
  }

  private startOfUtcDay(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private async tryGetSymbolFilters(
    gateway: ExchangeGateway,
    symbol: string,
  ): Promise<SymbolFilters | undefined> {
    try {
      return await gateway.getSymbolFilters(symbol);
    } catch {
      return undefined;
    }
  }
}
