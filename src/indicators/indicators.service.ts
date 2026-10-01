import { Injectable } from '@nestjs/common';
import { ADX, ATR, EMA, RSI } from 'technicalindicators';

/**
 * Wraps `technicalindicators` and left-pads results with `undefined` so the
 * output array stays index-aligned with the input candles (index i = value as of candle i).
 */
@Injectable()
export class IndicatorsService {
  ema(period: number, values: number[]): Array<number | undefined> {
    return this.align(values.length, EMA.calculate({ period, values }));
  }

  rsi(period: number, values: number[]): Array<number | undefined> {
    return this.align(values.length, RSI.calculate({ period, values }));
  }

  atr(period: number, highs: number[], lows: number[], closes: number[]): Array<number | undefined> {
    const result = ATR.calculate({ period, high: highs, low: lows, close: closes });
    return this.align(closes.length, result);
  }

  /** Wilder's ADX (trend strength, 0–100, direction-agnostic). */
  adx(period: number, highs: number[], lows: number[], closes: number[]): Array<number | undefined> {
    const result = ADX.calculate({ period, high: highs, low: lows, close: closes });
    return this.align(closes.length, result.map((r) => r.adx));
  }

  private align(inputLength: number, result: number[]): Array<number | undefined> {
    const padding: Array<number | undefined> = Array.from({ length: inputLength - result.length });
    return [...padding, ...result];
  }
}
