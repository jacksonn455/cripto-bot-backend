import { Inject, Injectable } from '@nestjs/common';
import { riskConfig } from '../config/configuration';
import { meetsMinNotional, roundDownToStep } from '../exchange/order-rounding.util';
import type { Signal } from '../strategy/strategy.interface';
import { isStopOnLosingSide, isTargetOnWinningSide, sideFromSignal } from '../trades/position-math.util';
import { RejectReason, RiskContext, RiskDecision } from './risk.interface';

/**
 * Approves or vetoes signals and sizes the position. Pure/synchronous by design so it
 * can be unit-tested without a database; persistence of the decision (signals.rejectReason)
 * is a separate concern (SignalsService), wired by the execution module.
 */
@Injectable()
export class RiskManagerService {
  constructor(
    @Inject(riskConfig.KEY)
    private readonly config: ReturnType<typeof riskConfig>,
  ) {}

  evaluate(signal: Signal, ctx: RiskContext): RiskDecision {
    const side = sideFromSignal(signal.action);
    if (!side) {
      // Risk only gates new entries; exits/no-action pass straight through to execution.
      return { approved: true };
    }

    if (ctx.isPaused) return this.reject('BOT_PAUSED');
    if (!ctx.reconciliationOk) return this.reject('RECONCILIATION_FAILED');
    // Never send a naked SELL to a venue that can't borrow: on Binance Spot it would just fail
    // (insufficient balance) or, worse, sell coins the account holds for another reason.
    if (side === 'SHORT' && ctx.shortSellingSupported !== true) return this.reject('SHORT_NOT_SUPPORTED');

    if (ctx.dailyPnl <= -this.config.maxDailyLossPct * ctx.accountEquity) {
      return this.reject('DAILY_LOSS_LIMIT');
    }
    if (ctx.consecutiveStopLosses >= this.config.maxConsecutiveStops) {
      return this.reject('CONSECUTIVE_STOPS_LIMIT');
    }
    if (ctx.openPositionsCount >= this.config.maxOpenPositions) {
      return this.reject('MAX_OPEN_POSITIONS');
    }

    if (signal.stopLoss === undefined) return this.reject('MISSING_STOP_LOSS');
    // A stop on the wrong side (e.g. above a long's entry) would "limit" a profit, not a loss.
    if (!isStopOnLosingSide(side, signal.price, signal.stopLoss)) return this.reject('INVALID_STOP_DISTANCE');
    const riskPerUnit = Math.abs(signal.price - signal.stopLoss);
    if (riskPerUnit <= 0) return this.reject('INVALID_STOP_DISTANCE');

    if (signal.takeProfit !== undefined) {
      if (!isTargetOnWinningSide(side, signal.price, signal.takeProfit)) {
        return this.reject('INVALID_TAKE_PROFIT');
      }
      const reward = Math.abs(signal.takeProfit - signal.price);
      if (reward / riskPerUnit < this.config.minRiskRewardRatio) {
        return this.reject('RR_TOO_LOW');
      }
    }

    if (ctx.symbolLiquidity) {
      if (ctx.symbolLiquidity.volume24h < this.config.minVolume24h) {
        return this.reject('LOW_LIQUIDITY');
      }
      if (ctx.symbolLiquidity.spreadPct > this.config.maxSpreadPct) {
        return this.reject('SPREAD_TOO_WIDE');
      }
    }

    const riskAmount = ctx.accountEquity * this.config.riskPerTradePct;
    let qty = riskAmount / riskPerUnit;

    const maxAssetNotional = ctx.accountEquity * this.config.maxExposurePerAssetPct;
    const currentAssetExposure = ctx.currentExposureByAsset[signal.symbol] ?? 0;
    qty = this.capQtyToRemainingNotional(qty, signal.price, maxAssetNotional - currentAssetExposure);

    const maxTotalNotional = ctx.accountEquity * this.config.maxTotalExposurePct;
    qty = this.capQtyToRemainingNotional(qty, signal.price, maxTotalNotional - ctx.totalExposure);

    if (qty <= 0) return this.reject('MAX_EXPOSURE_EXCEEDED');

    if (ctx.symbolFilters) {
      qty = roundDownToStep(qty, ctx.symbolFilters.stepSize);
      if (qty < ctx.symbolFilters.minQty) return this.reject('LOT_SIZE_TOO_SMALL');
      if (!meetsMinNotional(qty, signal.price, ctx.symbolFilters.minNotional)) {
        return this.reject('MIN_NOTIONAL_NOT_MET');
      }
    }

    return { approved: true, qty };
  }

  private capQtyToRemainingNotional(qty: number, price: number, remainingNotional: number): number {
    if (remainingNotional >= qty * price) return qty;
    return Math.max(0, remainingNotional / price);
  }

  private reject(rejectReason: RejectReason): RiskDecision {
    return { approved: false, rejectReason };
  }
}
