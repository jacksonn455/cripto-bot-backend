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
];

/**
 * Trend following with a higher-timeframe regime filter.
 * Regime: close > EMA200 (on regimeCandles). Entry: EMA fast crosses above EMA slow AND
 * RSI in [rsiMin, rsiMax]. Stop: entry - atrStopMultiplier*ATR. Exit: EMA fast crosses back
 * below EMA slow, or a chandelier-style ATR trailing stop over a rolling lookback window
 * (a v1 simplification of "highest high since entry", since the strategy itself is stateless).
 */
@Injectable()
export class TrendRegimeStrategy implements Strategy {
  readonly name = 'TrendRegimeStrategy';
  readonly paramSpec = PARAM_SPEC;

  constructor(
    private readonly indicators: IndicatorsService,
    @Inject(trendRegimeConfig.KEY)
    private readonly config: TrendRegimeConfig,
  ) {}

  getParams(): Record<string, number> {
    return Object.fromEntries(PARAM_SPEC.map((p) => [p.key, this.config[p.key]]));
  }

  withParams(overrides: Record<string, unknown>): TrendRegimeStrategy {
    const merged = mergeStrategyParams(PARAM_SPEC, this.getParams(), overrides);
    const problems: string[] = [];
    if (merged.emaFast >= merged.emaSlow) problems.push('emaFast must be lower than emaSlow');
    if (merged.rsiMin >= merged.rsiMax) problems.push('rsiMin must be lower than rsiMax');
    if (problems.length) throw new StrategyParamsError(problems);
    return new TrendRegimeStrategy(this.indicators, { ...this.config, ...merged });
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
    const regimeIsUp = lastEmaRegime !== undefined && lastRegimeClose > lastEmaRegime;

    const indicatorsSnapshot: Record<string, number | undefined> = {
      emaFast: emaFast[i],
      emaSlow: emaSlow[i],
      rsi: rsi[i],
      atr: atr[i],
      emaRegime: lastEmaRegime,
    };

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
      return this.none(symbol, last, indicatorsSnapshot, 'Posição aberta, sem gatilho de saída');
    }

    const crossedUp = this.crossedAbove(emaFast, emaSlow, i);
    const rsiValue = rsi[i];
    const rsiOk =
      rsiValue !== undefined && rsiValue >= this.config.rsiMin && rsiValue <= this.config.rsiMax;
    const atrValue = atr[i];

    if (regimeIsUp && crossedUp && rsiOk && atrValue !== undefined) {
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

    return this.none(
      symbol,
      last,
      indicatorsSnapshot,
      this.explainNoEntry(regimeIsUp, crossedUp, rsiOk),
    );
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

    if (this.crossedBelow(emaFast, emaSlow, i)) {
      return {
        action: 'EXIT',
        price: last.close,
        reason: `EMA${this.config.emaFast} cruzou abaixo da EMA${this.config.emaSlow}`,
      };
    }

    const atrValue = atr[i];
    if (atrValue !== undefined) {
      const from = Math.max(0, i - this.config.chandelierLookback + 1);
      const lookback = candles.slice(from, i + 1);
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

    void position; // reserved for future use (e.g. breakeven rules based on entryPrice)
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
    return reasons.length ? reasons.join('; ') : 'sem condicao de entrada';
  }
}
