import { Candle } from '../exchange/types/candle.type';
import { buildCandidateFeatures, featureParamsFrom } from '../candidates/candidate-features';
import { buildCandidateRecords } from '../candidates/candidate-records';
import type { CandidateRecord } from '../candidates/candidate.types';
import { RiskContext, RiskDecision } from '../risk/risk.interface';
import { RiskManagerService } from '../risk/risk-manager.service';
import { nextStopStreak } from '../risk/stop-streak.util';
import type { Signal, Strategy, StrategyContext } from '../strategy/strategy.interface';
import { computePnl, entryOrderSide, exitOrderSide, sideFromSignal, unrealizedPnl } from '../trades/position-math.util';
import type { TradeSide } from '../trades/schemas/trade.schema';
import {
  BacktestParams,
  BacktestResult,
  EquityPoint,
  FundingEvent,
  RejectedSignalRecord,
  SimulatedTrade,
  SymbolSeries,
} from './backtest.types';
import { stepOpenPosition } from './position-step.util';

const DAY_MS = 86_400_000;

interface OpenPosition {
  side: TradeSide;
  /** Fill price, slippage included. */
  entryPrice: number;
  /** Signal price before slippage, to report the slippage cost. */
  rawEntryPrice: number;
  qty: number;
  /** Current protective stop (moves with the trailing stop). */
  stopLoss: number;
  /** The stop the position was sized on: what the trade records, so R stays pnl ÷ planned risk. */
  initialStopLoss: number;
  takeProfit?: number;
  entryTime: number;
  mae: number;
  mfe: number;
  /** The protective stop has moved from the initial one (trailing stop): a hit exits as TRAILING. */
  trailed: boolean;
}

/** Per-symbol simulation state; the cash balance and the risk counters are shared. */
interface SymbolState {
  symbol: string;
  closed: Candle[];
  regime?: Candle[];
  /** Index of the next candle to process in `closed`. */
  next: number;
  /** regime[0..regimeEnd) have closeTime <= the current step. */
  regimeEnd: number;
  position: OpenPosition | null;
  lastClose?: number;
  filters?: BacktestParams['symbolFilters'];
  funding?: FundingEvent[];
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
   * One symbol (params.symbol) on its own balance.
   * @param regimeCandles Higher-timeframe candles for the strategy's regime filter (as the live
   *   loop passes them). At each step only the ones already closed by then are visible.
   */
  run(candles: Candle[], regimeCandles?: Candle[]): BacktestResult {
    return this.runPortfolio([
      { symbol: this.params.symbol, candles, regimeCandles, symbolFilters: this.params.symbolFilters },
    ]);
  }

  /**
   * Several symbols on ONE shared balance, stepped on a common clock like the live loop: the
   * risk manager sees every open position (count, exposure, same-side risk), and the daily loss
   * and consecutive-stop counters are account-wide. With a single symbol this is exactly `run`.
   * Symbols closing a candle at the same time are processed in the given order, so the first one
   * gets the risk budget first.
   */
  runPortfolio(series: SymbolSeries[]): BacktestResult {
    const lookback = this.params.candleLookback;
    const regimeLookback = this.params.regimeLookback ?? lookback;
    const tradeFrom = this.params.tradeFrom ?? -Infinity;
    // Defensive: a backtest must never evaluate a still-forming candle.
    const states: SymbolState[] = series.map((s) => ({
      symbol: s.symbol,
      closed: s.candles.filter((c) => c.isClosed),
      regime: s.regimeCandles?.filter((c) => c.isClosed),
      next: 0,
      regimeEnd: 0,
      position: null,
      filters: s.symbolFilters,
      funding: s.fundingEvents,
    }));
    const times = [...new Set(states.flatMap((s) => s.closed.map((c) => c.closeTime)))].sort((a, b) => a - b);

    let balance = this.params.initialBalance;
    let dailyPnl = 0;
    let currentDay = '';
    let consecutiveStopLosses = 0;
    let stopPauses = 0;

    const trades: SimulatedTrade[] = [];
    const equityCurve: EquityPoint[] = [];
    const signals: RejectedSignalRecord[] = [];
    // Observability only, and only on request: never read by the simulation.
    const candidates: CandidateRecord[] | undefined = this.params.recordCandidates ? [] : undefined;

    const close = (st: SymbolState, price: number, time: number, reason: SimulatedTrade['exitReason'], gapped = false) => {
      const trade = this.closePosition(st, st.position!, price, time, reason, gapped);
      trades.push(trade);
      balance += this.settlement(trade);
      dailyPnl += trade.pnl;
      st.position = null;
      return trade;
    };

    for (const time of times) {
      const trading = time >= tradeFrom;
      if (trading) {
        const day = new Date(time).toISOString().slice(0, 10);
        if (day !== currentDay) {
          currentDay = day;
          dailyPnl = 0;
          // Live, a streak of stops pauses the bot until someone resumes it. Nobody resumes a
          // simulation, and the streak only resets on a non-stop exit, which a vetoed bot never
          // makes: without this, one bad streak would end trading for the rest of the window.
          // Model: the pause lasts until the next UTC day, like the daily loss limit.
          if (consecutiveStopLosses >= this.riskManager.maxConsecutiveStops) {
            consecutiveStopLosses = 0;
            stopPauses++;
          }
        }
      }

      for (const st of states) {
        while (st.next < st.closed.length && st.closed[st.next].closeTime < time) st.next++;
        const i = st.next;
        const candle = st.closed[i];
        if (!candle || candle.closeTime !== time) continue;
        st.next = i + 1;
        if (st.regime) {
          while (st.regimeEnd < st.regime.length && st.regime[st.regimeEnd].closeTime <= candle.closeTime) st.regimeEnd++;
        }
        st.lastClose = candle.close;
        // Warm-up: history for the indicators only.
        if (!trading) continue;

        const window = st.closed.slice(lookback ? Math.max(0, i + 1 - lookback) : 0, i + 1);
        const regimeWindow = st.regime?.slice(regimeLookback ? Math.max(0, st.regimeEnd - regimeLookback) : 0, st.regimeEnd);

        if (st.position) {
          const p = st.position;
          const step = stepOpenPosition(p, candle, (openPosition) =>
            this.tryEvaluate(st.symbol, window, regimeWindow, openPosition),
          );
          if (step.kind === 'EXIT') {
            const closedTrade = close(st, step.price, candle.closeTime, step.reason, step.gapped);
            consecutiveStopLosses = nextStopStreak(consecutiveStopLosses, closedTrade.exitReason);
          } else {
            // Ratchet: the stop only ever tightens. Checked inside the next candles like any stop.
            p.stopLoss = step.stopLoss;
            p.trailed = step.trailed;
          }
        }

        if (!st.position) {
          const signal = this.tryEvaluate(st.symbol, window, regimeWindow, null);
          const side = signal ? sideFromSignal(signal.action) : null;
          let decision: RiskDecision | undefined;
          if (signal && side) {
            decision = this.riskManager.evaluate(signal, this.riskContext(st, states, balance, dailyPnl, consecutiveStopLosses));
            signals.push({
              candleTime: signal.candleTime,
              symbol: signal.symbol,
              approved: decision.approved,
              rejectReason: decision.rejectReason,
              indicators: signal.indicators,
              action: signal.action,
            });

            if (decision.approved && decision.qty) {
              const entryPrice = this.applySlippage(signal.price, entryOrderSide(side), this.params.slippagePct);
              balance -= entryPrice * decision.qty * this.params.feesPct;
              st.position = {
                side,
                entryPrice,
                rawEntryPrice: signal.price,
                qty: decision.qty,
                stopLoss: signal.stopLoss!,
                initialStopLoss: signal.stopLoss!,
                takeProfit: signal.takeProfit,
                entryTime: candle.closeTime,
                mae: 0,
                mfe: 0,
                trailed: false,
              };
            }
          }
          if (candidates && signal?.candidates?.length) {
            candidates.push(...this.candidateRecords(st.symbol, signal, decision, window, regimeWindow));
          }
        }

        if (st.position) {
          // Per-unit excursions in the position's favor/against it: a short gains when price falls.
          const isShort = st.position.side === 'SHORT';
          const favorable = isShort ? st.position.entryPrice - candle.low : candle.high - st.position.entryPrice;
          const adverse = isShort ? st.position.entryPrice - candle.high : candle.low - st.position.entryPrice;
          st.position.mfe = Math.max(st.position.mfe, favorable);
          st.position.mae = Math.min(st.position.mae, adverse);
        }
      }

      if (!trading) continue;
      let openPnl = 0;
      let openPositions = 0;
      for (const st of states) {
        if (!st.position) continue;
        openPositions++;
        openPnl += unrealizedPnl(st.position.side, st.position.entryPrice, st.lastClose ?? st.position.entryPrice, st.position.qty);
      }
      equityCurve.push({ timestamp: time, balance, equity: balance + openPnl, openPositions });
    }

    for (const st of states) {
      const lastCandle = st.closed[st.closed.length - 1];
      if (st.position && lastCandle) close(st, lastCandle.close, lastCandle.closeTime, 'MANUAL');
    }

    return { trades, equityCurve, signals, finalBalance: balance, stopPauses, ...(candidates ? { candidates } : {}) };
  }

  /**
   * Ledger rows for the setups that triggered on this candle (mode BACKTEST; the service adds the
   * runId). Pause is never on in a simulation: the stop-streak pause shows up as a RISK veto.
   */
  private candidateRecords(
    symbol: string,
    signal: Signal,
    decision: RiskDecision | undefined,
    window: Candle[],
    regimeWindow: Candle[] | undefined,
  ): CandidateRecord[] {
    const params = featureParamsFrom(this.strategy.getParams?.());
    const last = window[window.length - 1];
    return buildCandidateRecords({
      mode: 'BACKTEST',
      symbol,
      timeframe: last.interval,
      regimeTimeframe: regimeWindow?.[regimeWindow.length - 1]?.interval,
      signal,
      features: params ? buildCandidateFeatures(window, regimeWindow, params) : null,
      risk: decision,
      pause: { paused: false },
      entry: decision?.approved && decision.qty ? 'ENTERED' : undefined,
      evaluatedAt: new Date(last.closeTime),
    });
  }

  private riskContext(
    current: SymbolState,
    states: SymbolState[],
    balance: number,
    dailyPnl: number,
    consecutiveStopLosses: number,
  ): RiskContext {
    const open = states.filter((s) => s.position);
    const exposure = (s: SymbolState) => s.position!.entryPrice * s.position!.qty;
    const openRiskBySide = { LONG: 0, SHORT: 0 };
    for (const s of open) {
      openRiskBySide[s.position!.side] += Math.abs(s.position!.rawEntryPrice - s.position!.stopLoss) * s.position!.qty;
    }
    const filters = current.filters;
    return {
      accountEquity: balance,
      openPositionsCount: open.length,
      currentExposureByAsset: Object.fromEntries(open.map((s) => [s.symbol, exposure(s)])),
      totalExposure: open.reduce((sum, s) => sum + exposure(s), 0),
      dailyPnl,
      consecutiveStopLosses,
      isPaused: false,
      reconciliationOk: true,
      // The simulation can always short; whether it should is the strategy's allowShort knob.
      shortSellingSupported: true,
      maxSameSideRiskPct: this.params.maxSameSideRiskPct,
      openRiskBySide,
      symbolFilters: filters
        ? {
            symbol: current.symbol,
            baseAsset: '',
            quoteAsset: '',
            status: 'TRADING',
            minQty: filters.minQty,
            maxQty: Number.MAX_SAFE_INTEGER,
            stepSize: filters.stepSize,
            minPrice: 0,
            maxPrice: Number.MAX_SAFE_INTEGER,
            tickSize: 0,
            minNotional: filters.minNotional,
          }
        : undefined,
    };
  }

  /**
   * Balance change when a trade closes. The entry fee was already taken from the balance at entry,
   * while trade.pnl is net of all fees — so add it back to avoid charging it twice.
   */
  private settlement(trade: SimulatedTrade): number {
    return trade.pnl + trade.entryPrice * trade.qty * this.params.feesPct;
  }

  private tryEvaluate(
    symbol: string,
    candles: Candle[],
    regimeCandles: Candle[] | undefined,
    openPosition: StrategyContext['openPosition'],
  ): ReturnType<Strategy['onCandleClosed']> | null {
    try {
      return this.strategy.onCandleClosed({ symbol, candles, regimeCandles, openPosition });
    } catch {
      // Not enough candles yet for the strategy's indicators — treat as no decision.
      return null;
    }
  }

  private closePosition(
    st: SymbolState,
    position: OpenPosition,
    rawExitPrice: number,
    exitTime: number,
    reason: SimulatedTrade['exitReason'],
    gapped: boolean,
  ): SimulatedTrade {
    // Stops (initial or trailing) are stop-market orders: they get the stop slippage.
    const isStop = reason === 'SL' || reason === 'TRAILING';
    const slippagePct = isStop ? (this.params.stopSlippagePct ?? this.params.slippagePct) : this.params.slippagePct;
    const exitPrice = this.applySlippage(rawExitPrice, exitOrderSide(position.side), slippagePct);
    const entryFees = position.entryPrice * position.qty * this.params.feesPct;
    const exitFees = exitPrice * position.qty * this.params.feesPct;
    const carryCost = this.carryCost(st, position, exitTime);
    const fees = entryFees + exitFees + carryCost;
    const { pnl, pnlPct } = computePnl(position.side, position.entryPrice, exitPrice, position.qty, fees);
    const slippageCost =
      (Math.abs(position.entryPrice - position.rawEntryPrice) + Math.abs(exitPrice - rawExitPrice)) * position.qty;

    return {
      symbol: st.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      qty: position.qty,
      entryTime: position.entryTime,
      exitTime,
      fees,
      carryCost,
      slippageCost,
      gapCost: gapped ? Math.abs(rawExitPrice - position.stopLoss) * position.qty : 0,
      pnl,
      pnlPct,
      stopLoss: position.initialStopLoss,
      takeProfit: position.takeProfit,
      exitReason: reason,
      maxAdverseExcursion: position.mae * position.qty,
      maxFavorableExcursion: position.mfe * position.qty,
    };
  }

  /**
   * Cost of holding a short (0 for longs). With real funding history: what the perpetual short
   * paid at each settlement it was open for (positive funding = longs pay shorts, so the short
   * receives it and the cost is negative). Otherwise the flat shortBorrowPctPerDay.
   */
  private carryCost(st: SymbolState, position: OpenPosition, exitTime: number): number {
    if (position.side !== 'SHORT') return 0;
    const notional = position.entryPrice * position.qty;
    if (st.funding) {
      let rates = 0;
      for (const e of st.funding) {
        if (e.time > position.entryTime && e.time <= exitTime) rates += e.rate;
      }
      return -rates * notional;
    }
    return notional * (this.params.shortBorrowPctPerDay ?? 0) * (Math.max(0, exitTime - position.entryTime) / DAY_MS);
  }

  private applySlippage(price: number, side: 'BUY' | 'SELL', pct: number): number {
    return price * (side === 'BUY' ? 1 + pct : 1 - pct);
  }
}
