import { Candle } from '../exchange/types/candle.type';

export type SignalAction = 'ENTER_LONG' | 'ENTER_SHORT' | 'EXIT' | 'NONE';

export interface OpenPositionInfo {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  /** Close time (ms) of the entry candle; needed by the since-entry trailing stop. */
  entryTime?: number;
}

export interface StrategyContext {
  symbol: string;
  /** Closed candles only, oldest first, most recent (closed) candle last. */
  candles: Candle[];
  /** Higher-timeframe candles for the regime filter; defaults to `candles` if omitted. */
  regimeCandles?: Candle[];
  openPosition?: OpenPositionInfo | null;
}

export interface Signal {
  action: SignalAction;
  symbol: string;
  strategy: string;
  /** Close time (ms) of the candle that triggered this decision — never the forming candle. */
  candleTime: number;
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  /**
   * With an open position and no exit: the level the protective stop should move to (it only ever
   * tightens; the caller ignores a looser one). Only the since-entry trailing mode sets it.
   */
  trailingStop?: number;
  indicators: Record<string, number | undefined>;
  reason: string;
  /**
   * The entry conditions exactly as this decision judged them (observability only — never read for
   * trading). Absent with an open position, where the strategy evaluates exits instead.
   */
  conditions?: EntryConditions;
}

/** The three entry rules of one side, with the values the strategy compared. */
export interface EntryConditions {
  side: 'LONG' | 'SHORT';
  /** EMA fast crossed the slow one (above for LONG, below for SHORT) on this candle. */
  cross: { ok: boolean; emaFast?: number; emaSlow?: number };
  /** Higher-timeframe close vs. its EMA (× (1 ± band) when the regime band is on). */
  regime: { ok: boolean; close: number; ema?: number; bandPct: number };
  rsi: { ok: boolean; value?: number; min: number; max: number };
}

/**
 * Pure decision function: no exchange calls, no DB access. Only sees closed candles,
 * so it can never act on a candle that's still forming (no lookahead).
 */
export interface Strategy {
  readonly name: string;
  onCandleClosed(ctx: StrategyContext): Signal;
  /** Tunable numeric parameters (for backtests), with their allowed ranges. */
  readonly paramSpec?: readonly StrategyParamSpec[];
  /** Current parameter values (from env config). */
  getParams?(): Record<string, number>;
  /**
   * A copy of this strategy with some parameters overridden — used by backtests only; the
   * live instance is never mutated. Throws StrategyParamsError on invalid overrides.
   */
  withParams?(overrides: Record<string, unknown>): Strategy;
}

export interface StrategyParamSpec {
  key: string;
  description: string;
  min: number;
  max: number;
  integer: boolean;
  /**
   * Value at which the knob is off (e.g. a filter threshold of 0). At that value it is left out of
   * the backtest params hash, so adding a new, disabled knob doesn't make old runs look different.
   */
  neutral?: number;
  /** Only meaningful while this other param is not at its neutral value (left out of the hash otherwise). */
  requires?: string;
  /** Used when the config has no value for the key. */
  default?: number;
}

/**
 * The params that actually change the strategy's behavior: knobs at their neutral value, and knobs
 * whose `requires` param is neutral, are dropped. This is what goes into the backtest params hash.
 */
export function effectiveStrategyParams(
  spec: readonly StrategyParamSpec[],
  params: Record<string, number>,
): Record<string, number> {
  const isNeutral = (key: string) => {
    const s = spec.find((p) => p.key === key);
    return s?.neutral !== undefined && params[key] === s.neutral;
  };
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => {
      const s = spec.find((p) => p.key === key);
      if (!s) return true;
      if (isNeutral(key)) return false;
      return !(s.requires && isNeutral(s.requires));
    }),
  );
}

export class StrategyParamsError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

/** Validates overrides against a spec; returns the merged parameter set. */
export function mergeStrategyParams(
  spec: readonly StrategyParamSpec[],
  current: Record<string, number>,
  overrides: Record<string, unknown>,
): Record<string, number> {
  const problems: string[] = [];
  const merged = { ...current };
  for (const [key, raw] of Object.entries(overrides)) {
    const s = spec.find((p) => p.key === key);
    if (!s) {
      problems.push(`unknown parameter "${key}"`);
      continue;
    }
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${key} must be a number`);
    } else if (s.integer && !Number.isInteger(value)) {
      problems.push(`${key} must be an integer`);
    } else if (value < s.min || value > s.max) {
      problems.push(`${key} must be between ${s.min} and ${s.max}`);
    } else {
      merged[key] = value;
    }
  }
  if (problems.length) throw new StrategyParamsError(problems);
  return merged;
}
