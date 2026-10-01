import { Inject, Injectable } from '@nestjs/common';
import { trendRegimeConfig } from '../config/configuration';
import { Candle } from '../exchange/types/candle.type';
import { IndicatorsService } from '../indicators/indicators.service';
import {
  mergeStrategyParams,
  OpenPositionInfo,
  Signal,
  Strategy,
  StrategyContext,
  StrategyParamSpec,
  StrategyParamsError,
} from './strategy.interface';

type Series = Array<number | undefined>;

const NO_ENTRY = 'sem condicao de entrada';

type TrendRegimeConfig = ReturnType<typeof trendRegimeConfig>;
type NumericKey = {
  [K in keyof TrendRegimeConfig]: TrendRegimeConfig[K] extends number ? K : never;
}[keyof TrendRegimeConfig];

/** Every numeric knob of the strategy; symbols/timeframes are not strategy parameters. */
const PARAM_SPEC: ReadonlyArray<StrategyParamSpec & { key: NumericKey }> = [
  { key: 'emaFast', description: 'EMA rápida (períodos)', min: 2, max: 200, integer: true },
  { key: 'emaSlow', description: 'EMA lenta (períodos)', min: 3, max: 400, integer: true },
  { key: 'emaRegime', description: 'EMA do filtro de regime (períodos)', min: 10, max: 400, integer: true },
  { key: 'rsiPeriod', description: 'RSI (períodos)', min: 2, max: 100, integer: true },
  { key: 'rsiMin', description: 'RSI mínimo para entrar', min: 0, max: 100, integer: false },
  { key: 'rsiMax', description: 'RSI máximo para entrar', min: 0, max: 100, integer: false },
  { key: 'atrPeriod', description: 'ATR (períodos)', min: 2, max: 100, integer: true },
  { key: 'atrStopMultiplier', description: 'Stop = entrada − N × ATR', min: 0.1, max: 20, integer: false },
  { key: 'chandelierLookback', description: 'Trailing: janela da máxima (candles)', min: 2, max: 500, integer: true },
  { key: 'chandelierAtrMultiplier', description: 'Trailing: máxima − N × ATR', min: 0.1, max: 20, integer: false },
  {
    key: 'allowShort',
    description: 'Entradas Short (espelho das regras Long): 0 = desligado, 1 = ligado',
    min: 0,
    max: 1,
    integer: true,
    neutral: 0,
  },
  {
    key: 'adxMin',
    description: 'ADX mínimo (timeframe do regime) para entrar: 0 = filtro desligado',
    min: 0,
    max: 100,
    integer: false,
    neutral: 0,
  },
  {
    key: 'adxPeriod',
    description: 'ADX (períodos), só usado com o filtro de ADX ligado',
    min: 2,
    max: 100,
    integer: true,
    requires: 'adxMin',
    default: 14,
  },
  {
    key: 'regimeBandPct',
    description: 'Banda do regime em volta da EMA (fração: 0,01 = 1%; 0 = desligado)',
    min: 0,
    max: 0.2,
    integer: false,
    neutral: 0,
  },
  {
    key: 'trailingMode',
    description: 'Trailing: 0 = chandelier no fechamento (janela rolante); 1 = stop desde a entrada, dentro do candle',
    min: 0,
    max: 1,
    integer: true,
    neutral: 0,
  },
  {
    key: 'pullbackLookback',
    description: 'Entrada por pullback à EMA rápida nos últimos N candles: 0 = desligado',
    min: 0,
    max: 20,
    integer: true,
    neutral: 0,
  },
];

/** Knobs added after the first release: optional in the injected config, defaulting to "off". */
type OptionalKnob = 'allowShort' | 'adxMin' | 'adxPeriod' | 'regimeBandPct' | 'trailingMode' | 'pullbackLookback';

/**
 * Trend following with a higher-timeframe regime filter, symmetric for both directions.
 *
 * LONG — regime: close > EMA200 (on regimeCandles). Entry: EMA fast crosses above EMA slow AND
 * RSI in [rsiMin, rsiMax]. Stop: entry - atrStopMultiplier*ATR. Exit: EMA fast crosses back
 * below EMA slow, or a chandelier-style ATR trailing stop over a rolling lookback window
 * (a v1 simplification of "highest high since entry", since the strategy itself is stateless).
 *
 * SHORT (only when allowShort=1) — the exact mirror, with no extra tunable parameters:
 * regime close < EMA200, EMA fast crosses below EMA slow, RSI in [100-rsiMax, 100-rsiMin]
 * (the long band reflected around 50), stop entry + N*ATR, exit on the cross back up or when
 * close rises above lowest low + chandelierAtrMultiplier*ATR.
 *
 * Research filters, both off by default (see docs/ESTRATEGIA-PESQUISA.md, E5 and 1.2):
 *  - adxMin > 0: entries also need ADX(adxPeriod) on the regime candles >= adxMin (trend strength);
 *  - regimeBandPct > 0: the regime is up only above EMA × (1 + band) and down only below
 *    EMA × (1 − band), so a price hugging the EMA doesn't flip the regime back and forth.
 */
@Injectable()
export class TrendRegimeStrategy implements Strategy {
  readonly name = 'TrendRegimeStrategy';
  readonly paramSpec = PARAM_SPEC;

  constructor(
    private readonly indicators: IndicatorsService,
    @Inject(trendRegimeConfig.KEY)
    private readonly config: Omit<TrendRegimeConfig, OptionalKnob> & Partial<Pick<TrendRegimeConfig, OptionalKnob>>,
  ) {}

  getParams(): Record<string, number> {
    return Object.fromEntries(PARAM_SPEC.map((p) => [p.key, this.config[p.key] ?? p.default ?? 0]));
  }

  private get adxMin(): number {
    return this.config.adxMin ?? 0;
  }

  withParams(overrides: Record<string, unknown>): TrendRegimeStrategy {
    const merged = mergeStrategyParams(PARAM_SPEC, this.getParams(), overrides);
    const problems: string[] = [];
    if (merged.emaFast >= merged.emaSlow) problems.push('emaFast must be lower than emaSlow');
    if (merged.rsiMin >= merged.rsiMax) problems.push('rsiMin must be lower than rsiMax');
    if (problems.length) throw new StrategyParamsError(problems);
    return new TrendRegimeStrategy(this.indicators, { ...this.config, ...merged });
  }

  private get shortEnabled(): boolean {
    return this.config.allowShort === 1;
  }

  onCandleClosed(ctx: StrategyContext): Signal {
    const { candles, symbol } = ctx;
    const last = candles[candles.length - 1];
    if (!last || !last.isClosed) {
      throw new Error(
        'TrendRegimeStrategy requires the last candle to be closed (no lookahead)',
      );
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const emaFast = this.indicators.ema(this.config.emaFast, closes);
    const emaSlow = this.indicators.ema(this.config.emaSlow, closes);
    const rsi = this.indicators.rsi(this.config.rsiPeriod, closes);
    const atr = this.indicators.atr(this.config.atrPeriod, highs, lows, closes);

    const i = closes.length - 1;

    const regimeCandles = ctx.regimeCandles ?? candles;
    const regimeCloses = regimeCandles.map((c) => c.close);
    const emaRegime = this.indicators.ema(this.config.emaRegime, regimeCloses);
    const lastRegimeClose = regimeCloses[regimeCloses.length - 1];
    const lastEmaRegime = emaRegime[emaRegime.length - 1];
    const band = this.config.regimeBandPct ?? 0;
    const regimeIsUp = lastEmaRegime !== undefined && lastRegimeClose > lastEmaRegime * (1 + band);
    const regimeIsDown = lastEmaRegime !== undefined && lastRegimeClose < lastEmaRegime * (1 - band);

    const indicatorsSnapshot: Record<string, number | undefined> = {
      emaFast: emaFast[i],
      emaSlow: emaSlow[i],
      rsi: rsi[i],
      atr: atr[i],
      emaRegime: lastEmaRegime,
    };

    // Only computed when the filter is on, so the default path (and its snapshot) is unchanged.
    let adxOk = true;
    if (this.adxMin > 0) {
      const adx = this.indicators.adx(
        this.config.adxPeriod ?? 14,
        regimeCandles.map((c) => c.high),
        regimeCandles.map((c) => c.low),
        regimeCloses,
      );
      const lastAdx = adx[adx.length - 1];
      indicatorsSnapshot.adx = lastAdx;
      adxOk = lastAdx !== undefined && lastAdx >= this.adxMin;
    }

    if (ctx.openPosition) {
      const exit = this.checkExit(ctx.openPosition, candles, emaFast, emaSlow, atr, i);
      if (exit) {
        return {
          ...exit,
          symbol,
          strategy: this.name,
          candleTime: last.closeTime,
          indicators: indicatorsSnapshot,
        };
      }
      const held = this.none(symbol, last, indicatorsSnapshot, 'Posição aberta, sem gatilho de saída');
      const trailingStop = this.trailingSinceEntry ? this.trailingLevel(ctx.openPosition, candles, atr, i) : undefined;
      return trailingStop === undefined ? held : { ...held, trailingStop };
    }

    const rsiValue = rsi[i];
    const atrValue = atr[i];

    const crossedUp = this.crossedAbove(emaFast, emaSlow, i);
    const rsiOk =
      rsiValue !== undefined && rsiValue >= this.config.rsiMin && rsiValue <= this.config.rsiMax;

    if (regimeIsUp && crossedUp && rsiOk && adxOk && atrValue !== undefined) {
      const stopLoss = last.close - this.config.atrStopMultiplier * atrValue;
      return {
        action: 'ENTER_LONG',
        symbol,
        strategy: this.name,
        candleTime: last.closeTime,
        price: last.close,
        stopLoss,
        indicators: indicatorsSnapshot,
        reason:
          `EMA${this.config.emaFast} cruzou acima da EMA${this.config.emaSlow}, ` +
          `RSI(${this.config.rsiPeriod})=${rsiValue.toFixed(1)} dentro de ` +
          `[${this.config.rsiMin},${this.config.rsiMax}], regime de alta ` +
          `(close > EMA${this.config.emaRegime})`,
      };
    }

    const [shortRsiMin, shortRsiMax] = this.shortRsiBand();
    const crossedDown = this.crossedBelow(emaFast, emaSlow, i);
    const shortRsiOk = rsiValue !== undefined && rsiValue >= shortRsiMin && rsiValue <= shortRsiMax;

    if (this.shortEnabled && regimeIsDown && crossedDown && shortRsiOk && adxOk && atrValue !== undefined) {
      const stopLoss = last.close + this.config.atrStopMultiplier * atrValue;
      return {
        action: 'ENTER_SHORT',
        symbol,
        strategy: this.name,
        candleTime: last.closeTime,
        price: last.close,
        stopLoss,
        indicators: indicatorsSnapshot,
        reason:
          `EMA${this.config.emaFast} cruzou abaixo da EMA${this.config.emaSlow}, ` +
          `RSI(${this.config.rsiPeriod})=${rsiValue.toFixed(1)} dentro de ` +
          `[${shortRsiMin},${shortRsiMax}], regime de baixa ` +
          `(close < EMA${this.config.emaRegime})`,
      };
    }

    // V3 (docs/ESTRATEGIA-PESQUISA.md section 5): rejoin an established trend after a pullback.
    if (atrValue !== undefined && adxOk) {
      if (regimeIsUp && rsiOk && this.pullbackResumed('LONG', candles, emaFast, emaSlow, i)) {
        return {
          action: 'ENTER_LONG',
          symbol,
          strategy: this.name,
          candleTime: last.closeTime,
          price: last.close,
          stopLoss: last.close - this.config.atrStopMultiplier * atrValue,
          indicators: { ...indicatorsSnapshot, pullback: 1 },
          reason:
            `Pullback: EMA${this.config.emaFast} > EMA${this.config.emaSlow} nos últimos ${this.pullbackLookback} candles, ` +
            `preço tocou a EMA${this.config.emaFast} e fechou acima da máxima anterior, regime de alta`,
        };
      }
      if (this.shortEnabled && regimeIsDown && shortRsiOk && this.pullbackResumed('SHORT', candles, emaFast, emaSlow, i)) {
        return {
          action: 'ENTER_SHORT',
          symbol,
          strategy: this.name,
          candleTime: last.closeTime,
          price: last.close,
          stopLoss: last.close + this.config.atrStopMultiplier * atrValue,
          indicators: { ...indicatorsSnapshot, pullback: 1 },
          reason:
            `Pullback (short): EMA${this.config.emaFast} < EMA${this.config.emaSlow} nos últimos ${this.pullbackLookback} candles, ` +
            `preço tocou a EMA${this.config.emaFast} e fechou abaixo da mínima anterior, regime de baixa`,
        };
      }
    }

    return this.none(
      symbol,
      last,
      indicatorsSnapshot,
      this.withAdxReason(
        this.shortEnabled && !regimeIsUp
          ? this.explainNoShortEntry(regimeIsDown, crossedDown, shortRsiOk)
          : this.explainNoEntry(regimeIsUp, crossedUp, rsiOk),
        adxOk,
      ),
    );
  }

  private get trailingSinceEntry(): boolean {
    return this.config.trailingMode === 1;
  }

  private get pullbackLookback(): number {
    return this.config.pullbackLookback ?? 0;
  }

  /**
   * Pullback-resumption entry, exactly as pre-registered (N = pullbackLookback). LONG: EMA fast >
   * EMA slow on every candle t−N…t; some low in t−N…t−1 touched that candle's EMA fast; close[t] >
   * EMA fast[t] and close[t] > high[t−1]. SHORT is the mirror. The trend condition on t−1 also rules
   * out a fresh cross, which the cross entry already handles.
   */
  private pullbackResumed(side: 'LONG' | 'SHORT', candles: Candle[], emaFast: Series, emaSlow: Series, i: number): boolean {
    const n = this.pullbackLookback;
    if (n <= 0 || i - n < 1) return false;
    const long = side === 'LONG';
    for (let k = i - n; k <= i; k++) {
      const fast = emaFast[k];
      const slow = emaSlow[k];
      if (fast === undefined || slow === undefined || (long ? !(fast > slow) : !(fast < slow))) return false;
    }
    let touched = false;
    for (let k = i - n; k < i && !touched; k++) {
      touched = long ? candles[k].low <= emaFast[k]! : candles[k].high >= emaFast[k]!;
    }
    if (!touched) return false;
    const close = candles[i].close;
    return long
      ? close > emaFast[i]! && close > candles[i - 1].high
      : close < emaFast[i]! && close < candles[i - 1].low;
  }

  /**
   * Chandelier level from the extreme SINCE ENTRY (candles closed after the entry candle):
   * highest high − m × ATR for a long, lowest low + m × ATR for a short. undefined until a candle has
   * closed after the entry, or without entryTime. Candles older than the strategy window are not
   * visible, but the stop has already ratcheted past their level by then (it never loosens).
   */
  private trailingLevel(position: OpenPositionInfo, candles: Candle[], atr: Series, i: number): number | undefined {
    const atrValue = atr[i];
    if (position.entryTime === undefined || atrValue === undefined) return undefined;
    const since = candles.slice(0, i + 1).filter((c) => c.closeTime > position.entryTime!);
    if (since.length === 0) return undefined;
    const m = this.config.chandelierAtrMultiplier;
    return position.side === 'SHORT'
      ? Math.min(...since.map((c) => c.low)) + m * atrValue
      : Math.max(...since.map((c) => c.high)) - m * atrValue;
  }

  private withAdxReason(reason: string, adxOk: boolean): string {
    if (adxOk) return reason;
    const adx = `ADX abaixo de ${this.adxMin}`;
    return reason === NO_ENTRY ? adx : `${reason}; ${adx}`;
  }

  /** The long RSI band reflected around 50: [45, 70] for longs becomes [30, 55] for shorts. */
  private shortRsiBand(): [number, number] {
    return [100 - this.config.rsiMax, 100 - this.config.rsiMin];
  }

  private checkExit(
    position: OpenPositionInfo,
    candles: Candle[],
    emaFast: Series,
    emaSlow: Series,
    atr: Series,
    i: number,
  ): Pick<Signal, 'action' | 'price' | 'reason'> | null {
    const last = candles[i];
    const isShort = position.side === 'SHORT';

    const trendReversed = isShort
      ? this.crossedAbove(emaFast, emaSlow, i)
      : this.crossedBelow(emaFast, emaSlow, i);
    if (trendReversed) {
      return {
        action: 'EXIT',
        price: last.close,
        reason: `EMA${this.config.emaFast} cruzou ${isShort ? 'acima' : 'abaixo'} da EMA${this.config.emaSlow}`,
      };
    }

    const atrValue = atr[i];
    // With the since-entry trailing stop, the chandelier lives in the protective stop instead.
    if (atrValue !== undefined && !this.trailingSinceEntry) {
      const from = Math.max(0, i - this.config.chandelierLookback + 1);
      const lookback = candles.slice(from, i + 1);
      if (isShort) {
        const lowestLow = Math.min(...lookback.map((c) => c.low));
        const trailingStop = lowestLow + this.config.chandelierAtrMultiplier * atrValue;
        if (last.close > trailingStop) {
          return {
            action: 'EXIT',
            price: last.close,
            reason: `Chandelier exit (short): close ${last.close} > trailing stop ${trailingStop.toFixed(2)}`,
          };
        }
      } else {
        const highestHigh = Math.max(...lookback.map((c) => c.high));
        const trailingStop = highestHigh - this.config.chandelierAtrMultiplier * atrValue;
        if (last.close < trailingStop) {
          return {
            action: 'EXIT',
            price: last.close,
            reason: `Chandelier exit: close ${last.close} < trailing stop ${trailingStop.toFixed(2)}`,
          };
        }
      }
    }

    return null;
  }

  private crossedAbove(fast: Series, slow: Series, i: number): boolean {
    const prev = i - 1;
    return (
      prev >= 0 &&
      fast[prev] !== undefined &&
      slow[prev] !== undefined &&
      fast[prev]! <= slow[prev]! &&
      fast[i] !== undefined &&
      slow[i] !== undefined &&
      fast[i]! > slow[i]!
    );
  }

  private crossedBelow(fast: Series, slow: Series, i: number): boolean {
    const prev = i - 1;
    return (
      prev >= 0 &&
      fast[prev] !== undefined &&
      slow[prev] !== undefined &&
      fast[prev]! >= slow[prev]! &&
      fast[i] !== undefined &&
      slow[i] !== undefined &&
      fast[i]! < slow[i]!
    );
  }

  private none(
    symbol: string,
    last: Candle,
    indicators: Record<string, number | undefined>,
    reason: string,
  ): Signal {
    return {
      action: 'NONE',
      symbol,
      strategy: this.name,
      candleTime: last.closeTime,
      price: last.close,
      indicators,
      reason,
    };
  }

  private explainNoEntry(regimeIsUp: boolean, crossedUp: boolean, rsiOk: boolean): string {
    const reasons: string[] = [];
    if (!regimeIsUp) reasons.push('regime nao esta em alta');
    if (!crossedUp) reasons.push('sem cruzamento EMA rapida/lenta');
    if (!rsiOk) reasons.push('RSI fora da faixa');
    return reasons.length ? reasons.join('; ') : NO_ENTRY;
  }

  /** Used when shorts are enabled and the regime is not up (so the long side can't trigger anyway). */
  private explainNoShortEntry(regimeIsDown: boolean, crossedDown: boolean, rsiOk: boolean): string {
    const reasons: string[] = [];
    if (!regimeIsDown) reasons.push('regime indefinido (nem alta nem baixa)');
    if (!crossedDown) reasons.push('short: sem cruzamento EMA rapida abaixo da lenta');
    if (!rsiOk) reasons.push('short: RSI fora da faixa');
    return reasons.length ? reasons.join('; ') : NO_ENTRY;
  }
}
