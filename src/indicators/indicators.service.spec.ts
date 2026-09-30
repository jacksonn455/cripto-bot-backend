import { IndicatorsService } from './indicators.service';

describe('IndicatorsService', () => {
  const service = new IndicatorsService();

  describe('ema', () => {
    it('aligns output with input length and matches the hand-calculated EMA', () => {
      // period=3 EMA of [1,2,3,4,5,6]: seed = SMA(1,2,3)=2, k=2/(3+1)=0.5
      const values = [1, 2, 3, 4, 5, 6];
      const result = service.ema(3, values);
      expect(result).toHaveLength(values.length);
      expect(result[0]).toBeUndefined();
      expect(result[1]).toBeUndefined();
      expect(result[2]).toBeCloseTo(2);
      expect(result[3]).toBeCloseTo(3);
      expect(result[4]).toBeCloseTo(4);
      expect(result[5]).toBeCloseTo(5);
    });
  });

  describe('rsi', () => {
    it('trends high for a strictly rising series', () => {
      const values = Array.from({ length: 30 }, (_, i) => 100 + i);
      const result = service.rsi(14, values);
      expect(result[result.length - 1]).toBeGreaterThan(70);
    });

    it('trends low for a strictly falling series', () => {
      const values = Array.from({ length: 30 }, (_, i) => 200 - i);
      const result = service.rsi(14, values);
      expect(result[result.length - 1]).toBeLessThan(30);
    });

    it('stays within [0, 100]', () => {
      const values = [10, 12, 9, 15, 11, 20, 8, 25, 5, 30, 4, 35, 3, 40, 2, 45];
      const result = service.rsi(14, values);
      for (const v of result) {
        if (v !== undefined) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(100);
        }
      }
    });
  });

  describe('atr', () => {
    it('equals the constant true range when high-low range never changes and closes have no gaps', () => {
      const range = 5;
      const closes = Array.from({ length: 20 }, () => 100);
      const highs = closes.map((c) => c + range / 2);
      const lows = closes.map((c) => c - range / 2);
      const result = service.atr(14, highs, lows, closes);
      const last = result[result.length - 1];
      expect(last).toBeCloseTo(range);
    });
  });
});
