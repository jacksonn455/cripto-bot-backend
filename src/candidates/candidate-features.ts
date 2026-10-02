import type { Candle } from '../exchange/types/candle.type';
import { IndicatorsService } from '../indicators/indicators.service';

/** Bumped whenever a feature's definition changes, so stored features are never compared across versions. */
export const CANDIDATE_FEATURES_VERSION = 1;

export interface CandidateFeatureParams {
  emaFast: number;
  emaSlow: number;
  emaRegime: number;
  rsiPeriod: number;
  atrPeriod: number;
  adxPeriod: number;
  /** Regime band (fraction) the strategy applies around the regime EMA; 0 = plain close vs EMA. */
  regimeBandPct: number;
}

export type RegimeState = 'UP' | 'DOWN' | 'NEUTRAL' | 'UNKNOWN';

/**
 * What the market looked like at a candidate's candle, from closed candles only. Raw values are the
 * very numbers the strategy compared; the normalized ones (ATR units and fractions, no absolute
 * prices) are what a future judge should reason with. Only indicators the strategy already uses —
 * no new ones. `null` = not computable yet on this window.
 */
export interface CandidateFeatures {
  version: number;
  close: number;
  emaFast: number | null;
  emaSlow: number | null;
  rsi: number | null;
  atr: number | null;
  /** ADX on the regime candles (the strategy's optional filter input), whether or not the filter is on. */
  adx: number | null;
  /** ATR / close (fraction). */
  atrToPrice: number | null;
  /** (EMA fast − EMA slow) / ATR. */
  emaSpreadAtr: number | null;
  /** (close − EMA fast) / ATR. */
  closeVsEmaFastAtr: number | null;
  /** close / previous close − 1. */
  return1: number | null;
  /** close / close 24 candles earlier − 1 (as the AI market snapshot reported). */
  return24: number | null;
  regime: {
    close: number | null;
    ema: number | null;
    /** regime close / regime EMA − 1. */
    distance: number | null;
    /** The strategy's own reading, band included. */
    state: RegimeState;
  };
}

const DEFAULT_INDICATORS = new IndicatorsService();

/** Strategy params (as `Strategy.getParams()` returns them) → feature params; null when one is missing. */
export function featureParamsFrom(params: Record<string, number> | undefined): CandidateFeatureParams | null {
  if (!params) return null;
  const required = ['emaFast', 'emaSlow', 'emaRegime', 'rsiPeriod', 'atrPeriod'] as const;
  if (required.some((k) => typeof params[k] !== 'number')) return null;
  return {
    emaFast: params.emaFast,
    emaSlow: params.emaSlow,
    emaRegime: params.emaRegime,
    rsiPeriod: params.rsiPeriod,
    atrPeriod: params.atrPeriod,
    adxPeriod: params.adxPeriod ?? 14,
    regimeBandPct: params.regimeBandPct ?? 0,
  };
}

/**
 * Pure: same candles + params → same features, wherever it runs (live, paper, backtest, AI tools,
 * a future judge). Pass exactly the window the strategy saw (see strategyWindowSize) — indicator
 * values depend on where the window starts. `regimeCandles` defaults to `candles`, as in the strategy.
 */
export function buildCandidateFeatures(
  candles: readonly Candle[],
  regimeCandles: readonly Candle[] | undefined,
  params: CandidateFeatureParams,
  indicators: IndicatorsService = DEFAULT_INDICATORS,
): CandidateFeatures {
  const last = candles[candles.length - 1];
  if (!last) throw new Error('buildCandidateFeatures needs at least one candle');
  const closes = candles.map((c) => c.close);
  const i = closes.length - 1;
  const pick = (series: Array<number | undefined>, at = series.length - 1) => series[at] ?? null;

  const emaFast = pick(indicators.ema(params.emaFast, closes));
  const emaSlow = pick(indicators.ema(params.emaSlow, closes));
  const rsi = pick(indicators.rsi(params.rsiPeriod, closes));
  const atr = pick(indicators.atr(params.atrPeriod, candles.map((c) => c.high), candles.map((c) => c.low), closes));

  const regime = regimeCandles ?? candles;
  const regimeCloses = regime.map((c) => c.close);
  const regimeEma = regimeCloses.length ? pick(indicators.ema(params.emaRegime, regimeCloses)) : null;
  const regimeClose = regimeCloses[regimeCloses.length - 1] ?? null;
  const adx = regime.length
    ? pick(indicators.adx(params.adxPeriod, regime.map((c) => c.high), regime.map((c) => c.low), regimeCloses))
    : null;

  const perAtr = (v: number | null) => (v === null || atr === null || atr === 0 ? null : v / atr);
  const ratio = (a: number | null | undefined, b: number | null | undefined) =>
    a === null || a === undefined || b === null || b === undefined || b === 0 ? null : a / b - 1;

  return {
    version: CANDIDATE_FEATURES_VERSION,
    close: last.close,
    emaFast,
    emaSlow,
    rsi,
    atr,
    adx,
    atrToPrice: atr === null ? null : atr / last.close,
    emaSpreadAtr: perAtr(emaFast === null || emaSlow === null ? null : emaFast - emaSlow),
    closeVsEmaFastAtr: perAtr(emaFast === null ? null : last.close - emaFast),
    return1: i >= 1 ? ratio(last.close, closes[i - 1]) : null,
    return24: i >= 24 ? ratio(last.close, closes[i - 24]) : null,
    regime: {
      close: regimeClose,
      ema: regimeEma,
      distance: ratio(regimeClose, regimeEma),
      state: regimeState(regimeClose, regimeEma, params.regimeBandPct),
    },
  };
}

/** Same comparison as TrendRegimeStrategy: up above EMA × (1 + band), down below EMA × (1 − band). */
function regimeState(close: number | null, ema: number | null, band: number): RegimeState {
  if (close === null || ema === null) return 'UNKNOWN';
  if (close > ema * (1 + band)) return 'UP';
  if (close < ema * (1 - band)) return 'DOWN';
  return 'NEUTRAL';
}
