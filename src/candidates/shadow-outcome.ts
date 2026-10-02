import { stepOpenPosition, type SteppedPosition } from '../backtest/position-step.util';
import type { Candle } from '../exchange/types/candle.type';
import type { Signal, Strategy } from '../strategy/strategy.interface';
import type { ShadowOutcome } from './candidate.types';

const DAY_MS = 86_400_000;

export interface ShadowCosts {
  feesPct: number;
  slippagePct: number;
  stopSlippagePct: number;
  shortBorrowPctPerDay: number;
}

/** The research protocol's 1× costs (docs/ESTRATEGIA-PESQUISA.md §5). */
export const DEFAULT_SHADOW_COSTS: ShadowCosts = {
  feesPct: 0.001,
  slippagePct: 0.0005,
  stopSlippagePct: 0.001,
  shortBorrowPctPerDay: 0.0003,
};

export interface ShadowInput {
  /** Supplies the exit rules (EMA cross back, chandelier, since-entry trailing) — same instance/params as the run. */
  strategy: Strategy;
  symbol: string;
  side: 'LONG' | 'SHORT';
  /** Candle close the candidate was judged at (hypothetical entry before slippage). */
  price: number;
  /** The strategy's initial stop for this candidate. */
  stopLoss: number;
  candleCloseTime: number;
  /** Closed candles, oldest first, including the candidate candle and the window before it. */
  candles: readonly Candle[];
  regimeCandles?: readonly Candle[];
  /** Candles the strategy sees per step (strategyWindowSize). */
  windowSize: number;
  regimeWindowSize?: number;
  costs?: ShadowCosts;
  /** Stop looking after this many candles (status OPEN). */
  maxBars?: number;
}

/**
 * What a candidate would have done if traded: entry at its close (with slippage), the strategy's
 * stop, and the backtest's own per-candle exit step (stepOpenPosition) until an exit fires or the
 * data ends. Pure and analytical: no order, no balance, no risk sizing (results are per unit, in R).
 * Returns null when the candidate candle isn't in `candles`.
 */
export function simulateShadowOutcome(input: ShadowInput): Omit<ShadowOutcome, 'computedAt'> | null {
  const costs = input.costs ?? DEFAULT_SHADOW_COSTS;
  const candles = input.candles;
  const start = candles.findIndex((c) => c.closeTime === input.candleCloseTime);
  if (start < 0) return null;
  const long = input.side === 'LONG';
  const entry = input.price * (long ? 1 + costs.slippagePct : 1 - costs.slippagePct);
  const risk = Math.abs(entry - input.stopLoss);
  if (!(risk > 0)) return null;

  const position: SteppedPosition = {
    side: input.side,
    entryPrice: entry,
    stopLoss: input.stopLoss,
    entryTime: input.candleCloseTime,
    trailed: false,
  };
  const regime = input.regimeCandles;
  const regimeSize = input.regimeWindowSize ?? input.windowSize;
  let regimeEnd = 0;
  let mfe = 0;
  let mae = 0;
  const maxBars = input.maxBars ?? Infinity;

  const result = (status: 'CLOSED' | 'OPEN', rawExit: number, bars: number, extra: Partial<ShadowOutcome> = {}) => {
    const isStop = extra.exitReason === 'SL' || extra.exitReason === 'TRAILING';
    const exitSlip = status === 'OPEN' ? 0 : isStop ? costs.stopSlippagePct : costs.slippagePct;
    const exit = rawExit * (long ? 1 - exitSlip : 1 + exitSlip);
    const exitTime = extra.exitTime ?? candles[Math.min(candles.length - 1, start + bars)].closeTime;
    const carry = long ? 0 : entry * costs.shortBorrowPctPerDay * (Math.max(0, exitTime - input.candleCloseTime) / DAY_MS);
    const fees = costs.feesPct * (entry + (status === 'OPEN' ? rawExit : exit));
    const net = (long ? exit - entry : entry - exit) - fees - carry;
    const r = net / risk;
    return {
      status,
      outcome: status === 'OPEN' ? ('OPEN' as const) : r > 0 ? ('WIN' as const) : ('LOSS' as const),
      r,
      returnPct: net / entry,
      barsHeld: bars,
      mfeR: mfe / risk,
      maeR: mae / risk,
      costs,
      ...extra,
      ...(status === 'CLOSED' ? { exitPrice: exit } : {}),
    };
  };

  for (let j = start + 1; j < candles.length; j++) {
    const bars = j - start;
    if (bars > maxBars) return result('OPEN', candles[j - 1].close, bars - 1);
    const candle = candles[j];
    if (regime) {
      while (regimeEnd < regime.length && regime[regimeEnd].closeTime <= candle.closeTime) regimeEnd++;
    }
    const window = candles.slice(Math.max(0, j + 1 - input.windowSize), j + 1) as Candle[];
    const regimeWindow = regime?.slice(Math.max(0, regimeEnd - regimeSize), regimeEnd) as Candle[] | undefined;

    const step = stepOpenPosition(position, candle, (openPosition) =>
      tryEvaluate(() =>
        input.strategy.onCandleClosed({ symbol: input.symbol, candles: window, regimeCandles: regimeWindow, openPosition }),
      ),
    );
    // Excursions of the candles after the entry (the entry candle traded before the entry did).
    mfe = Math.max(mfe, long ? candle.high - entry : entry - candle.low);
    mae = Math.min(mae, long ? candle.low - entry : entry - candle.high);
    if (step.kind === 'EXIT') {
      return result('CLOSED', step.price, bars, { exitReason: step.reason, exitTime: candle.closeTime });
    }
    position.stopLoss = step.stopLoss;
    position.trailed = step.trailed;
  }
  const bars = candles.length - 1 - start;
  return result('OPEN', candles[candles.length - 1].close, bars);
}

function tryEvaluate(fn: () => Signal): Signal | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
