import { Candle } from '../exchange/types/candle.type';
import { RiskContext } from '../risk/risk.interface';
import { RiskManagerService } from '../risk/risk-manager.service';
import type { Strategy, StrategyContext } from '../strategy/strategy.interface';
import {
  BacktestParams,
  BacktestResult,
  EquityPoint,
  RejectedSignalRecord,
  SimulatedTrade,
} from './backtest.types';
import { checkIntraCandleExit } from './intra-candle-exit.util';

interface OpenPosition {
  entryPrice: number;
  qty: number;
  stopLoss: number;
  takeProfit?: number;
  entryTime: number;
  mae: number;
  mfe: number;
}

/**
 * Pure candle-by-candle simulation engine. No I/O: takes already-fetched closed candles
 * and returns trades/equity/signals for the caller to persist. Uses the exact same
 * Strategy and RiskManager instances as paper/live — only the "exchange" is simulated here.
 */
export class BacktestRunner {
  constructor(
    private readonly strategy: Strategy,
    private readonly riskManager: RiskManagerService,
    private readonly params: BacktestParams,
  ) {}

  /**
   * @param regimeCandles Higher-timeframe candles for the strategy's regime filter (as the live
   *   loop passes them). At each step only the ones already closed by then are visible.
   */
  run(candles: Candle[], regimeCandles?: Candle[]): BacktestResult {
    // Defensive: a backtest must never evaluate a still-forming candle.
    const closed = candles.filter((c) => c.isClosed);
    const regimeClosed = regimeCandles?.filter((c) => c.isClosed);
    const lookback = this.params.candleLookback;
    const tradeFrom = this.params.tradeFrom ?? -Infinity;
    let regimeEnd = 0; // regimeClosed[0..regimeEnd) have closeTime <= current candle closeTime

    let balance = this.params.initialBalance;
    let openPosition: OpenPosition | null = null;
    let dailyPnl = 0;
    let currentDay = '';
    let consecutiveStopLosses = 0;

    const trades: SimulatedTrade[] = [];
    const equityCurve: EquityPoint[] = [];
    const signals: RejectedSignalRecord[] = [];

    for (let i = 0; i < closed.length; i++) {
      const candle = closed[i];
      if (regimeClosed) {
        while (regimeEnd < regimeClosed.length && regimeClosed[regimeEnd].closeTime <= candle.closeTime) regimeEnd++;
      }
      // Warm-up: history for the indicators only.
      if (candle.closeTime < tradeFrom) continue;

      const day = new Date(candle.closeTime).toISOString().slice(0, 10);
      if (day !== currentDay) {
        currentDay = day;
        dailyPnl = 0;
      }

      const window = closed.slice(lookback ? Math.max(0, i + 1 - lookback) : 0, i + 1);
      const regimeWindow = regimeClosed?.slice(lookback ? Math.max(0, regimeEnd - lookback) : 0, regimeEnd);

      if (openPosition) {
        const intraCandleExit = checkIntraCandleExit(openPosition, candle);
        if (intraCandleExit) {
          const closedTrade = this.closePosition(
            openPosition,
            intraCandleExit.exitPrice,
            candle.closeTime,
            intraCandleExit.reason,
          );
          trades.push(closedTrade);
          balance += this.settlement(closedTrade);
          dailyPnl += closedTrade.pnl;
          consecutiveStopLosses = closedTrade.exitReason === 'SL' ? consecutiveStopLosses + 1 : 0;
          openPosition = null;
        } else {
          const signal = this.tryEvaluate(window, regimeWindow, {
            side: 'LONG',
            entryPrice: openPosition.entryPrice,
            stopLoss: openPosition.stopLoss,
          });
          if (signal?.action === 'EXIT') {
            const closedTrade = this.closePosition(openPosition, signal.price, candle.closeTime, 'SIGNAL');
            trades.push(closedTrade);
            balance += this.settlement(closedTrade);
            dailyPnl += closedTrade.pnl;
            consecutiveStopLosses = 0;
            openPosition = null;
          }
        }
      }

      if (!openPosition) {
        const signal = this.tryEvaluate(window, regimeWindow, null);
        if (signal && (signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT')) {
          const riskCtx: RiskContext = {
            accountEquity: balance,
            openPositionsCount: 0,
            currentExposureByAsset: {},
            totalExposure: 0,
            dailyPnl,
            consecutiveStopLosses,
            isPaused: false,
            reconciliationOk: true,
            symbolFilters: this.params.symbolFilters
              ? {
                  symbol: this.params.symbol,
                  baseAsset: '',
                  quoteAsset: '',
                  status: 'TRADING',
                  minQty: this.params.symbolFilters.minQty,
                  maxQty: Number.MAX_SAFE_INTEGER,
                  stepSize: this.params.symbolFilters.stepSize,
                  minPrice: 0,
                  maxPrice: Number.MAX_SAFE_INTEGER,
                  tickSize: 0,
                  minNotional: this.params.symbolFilters.minNotional,
                }
              : undefined,
          };
          const decision = this.riskManager.evaluate(signal, riskCtx);
          signals.push({
            candleTime: signal.candleTime,
            symbol: signal.symbol,
            approved: decision.approved,
            rejectReason: decision.rejectReason,
            indicators: signal.indicators,
            action: signal.action,
          });

          if (decision.approved && decision.qty) {
            const entryPrice = this.applySlippage(signal.price, 'BUY');
            const fees = entryPrice * decision.qty * this.params.feesPct;
            balance -= fees;
            openPosition = {
              entryPrice,
              qty: decision.qty,
              stopLoss: signal.stopLoss!,
              takeProfit: signal.takeProfit,
              entryTime: candle.closeTime,
              mae: 0,
              mfe: 0,
            };
          }
        }
      }

      if (openPosition) {
        const favorable = candle.high - openPosition.entryPrice;
        const adverse = candle.low - openPosition.entryPrice;
        openPosition.mfe = Math.max(openPosition.mfe, favorable);
        openPosition.mae = Math.min(openPosition.mae, adverse);
      }

      const unrealizedPnl = openPosition
        ? (candle.close - openPosition.entryPrice) * openPosition.qty
        : 0;
      equityCurve.push({
        timestamp: candle.closeTime,
        balance,
        equity: balance + unrealizedPnl,
        openPositions: openPosition ? 1 : 0,
      });
    }

    if (openPosition && closed.length > 0) {
      const lastCandle = closed[closed.length - 1];
      const closedTrade = this.closePosition(openPosition, lastCandle.close, lastCandle.closeTime, 'MANUAL');
      trades.push(closedTrade);
      balance += this.settlement(closedTrade);
    }

    return { trades, equityCurve, signals, finalBalance: balance };
  }

  /**
   * Balance change when a trade closes. The entry fee was already taken from the balance at entry,
   * while trade.pnl is net of both fees — so add it back to avoid charging it twice.
   */
  private settlement(trade: SimulatedTrade): number {
    return trade.pnl + trade.entryPrice * trade.qty * this.params.feesPct;
  }

  private tryEvaluate(
    candles: Candle[],
    regimeCandles: Candle[] | undefined,
    openPosition: StrategyContext['openPosition'],
  ): ReturnType<Strategy['onCandleClosed']> | null {
    try {
      return this.strategy.onCandleClosed({ symbol: this.params.symbol, candles, regimeCandles, openPosition });
    } catch {
      // Not enough candles yet for the strategy's indicators — treat as no decision.
      return null;
    }
  }

  private closePosition(
    position: OpenPosition,
    rawExitPrice: number,
    exitTime: number,
    reason: SimulatedTrade['exitReason'],
  ): SimulatedTrade {
    const exitPrice = this.applySlippage(rawExitPrice, 'SELL');
    const entryFees = position.entryPrice * position.qty * this.params.feesPct;
    const exitFees = exitPrice * position.qty * this.params.feesPct;
    const fees = entryFees + exitFees;
    const pnl = (exitPrice - position.entryPrice) * position.qty - fees;
    const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;

    return {
      symbol: this.params.symbol,
      side: 'LONG',
      entryPrice: position.entryPrice,
      exitPrice,
      qty: position.qty,
      entryTime: position.entryTime,
      exitTime,
      fees,
      pnl,
      pnlPct,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      exitReason: reason,
      maxAdverseExcursion: position.mae * position.qty,
      maxFavorableExcursion: position.mfe * position.qty,
    };
  }

  private applySlippage(price: number, side: 'BUY' | 'SELL'): number {
    const factor = side === 'BUY' ? 1 + this.params.slippagePct : 1 - this.params.slippagePct;
    return price * factor;
  }
}
