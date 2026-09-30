import { meetsMinNotional, roundDownToStep } from './order-rounding.util';

describe('order-rounding.util', () => {
  describe('roundDownToStep', () => {
    it('rounds down qty to LOT_SIZE step without float artifacts', () => {
      expect(roundDownToStep(0.1, 0.001)).toBe(0.1);
      expect(roundDownToStep(0.1236, 0.001)).toBe(0.123);
      expect(roundDownToStep(0.123456, 0.00001)).toBe(0.12345);
    });

    it('rounds down price to PRICE_FILTER tick', () => {
      expect(roundDownToStep(123.456, 0.01)).toBe(123.45);
      expect(roundDownToStep(60000.789, 0.1)).toBe(60000.7);
    });

    it('never rounds up', () => {
      expect(roundDownToStep(1.999, 1)).toBe(1);
    });

    it('returns the value unchanged when step is 0 (filter disabled)', () => {
      expect(roundDownToStep(1.23456789, 0)).toBe(1.23456789);
    });
  });

  describe('meetsMinNotional', () => {
    it('passes when notional is above the minimum', () => {
      expect(meetsMinNotional(1, 100, 10)).toBe(true);
    });

    it('fails when notional is below the minimum', () => {
      expect(meetsMinNotional(0.01, 100, 10)).toBe(false);
    });

    it('always passes when minNotional is 0 (filter disabled)', () => {
      expect(meetsMinNotional(0, 0, 0)).toBe(true);
    });
  });
});
