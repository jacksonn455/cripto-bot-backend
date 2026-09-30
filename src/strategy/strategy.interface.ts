import { Candle } from '../exchange/types/candle.type';

export type SignalAction = 'ENTER_LONG' | 'ENTER_SHORT' | 'EXIT' | 'NONE';

export interface OpenPositionInfo {
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
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
  indicators: Record<string, number | undefined>;
  reason: string;
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
