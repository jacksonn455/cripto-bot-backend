import {
  computePnl,
  entryOrderSide,
  exitOrderSide,
  isStopOnLosingSide,
  isTargetOnWinningSide,
  positionValue,
  sideFromSignal,
  unrealizedPnl,
} from './position-math.util';

describe('position math', () => {
  describe('computePnl', () => {
    it('LONG profits when price rises', () => {
      // (110 - 100) * 2 = +20; +10% on the entry notional.
      expect(computePnl('LONG', 100, 110, 2)).toEqual({ pnl: 20, pnlPct: 10 });
    });

    it('LONG loses when price falls', () => {
      expect(computePnl('LONG', 100, 95, 2)).toEqual({ pnl: -10, pnlPct: -5 });
    });

    it('SHORT profits when price falls: (entry - exit) * qty', () => {
      // Sold 2 @ 100, bought back @ 90: +20, +10% on the 200 notional.
      expect(computePnl('SHORT', 100, 90, 2)).toEqual({ pnl: 20, pnlPct: 10 });
    });

    it('SHORT loses when price rises', () => {
      expect(computePnl('SHORT', 100, 105, 2)).toEqual({ pnl: -10, pnlPct: -5 });
    });

    it('subtracts fees from pnl but not from pnlPct (same convention as the backtest)', () => {
      expect(computePnl('SHORT', 100, 90, 2, 0.5)).toEqual({ pnl: 19.5, pnlPct: 10 });
      expect(computePnl('LONG', 100, 110, 2, 0.5)).toEqual({ pnl: 19.5, pnlPct: 10 });
    });

    it('a breakeven round trip is zero for both sides', () => {
      expect(computePnl('LONG', 100, 100, 3).pnl).toBe(0);
      expect(computePnl('SHORT', 100, 100, 3).pnl).toBe(-0);
    });

    it('is exactly mirrored: a long and a short over the same move sum to zero', () => {
      const long = computePnl('LONG', 63_250.5, 61_010.25, 0.0137);
      const short = computePnl('SHORT', 63_250.5, 61_010.25, 0.0137);
      expect(long.pnl + short.pnl).toBeCloseTo(0, 10);
      expect(long.pnlPct + short.pnlPct).toBeCloseTo(0, 10);
    });

    it('guards against a zero entry price', () => {
      expect(computePnl('LONG', 0, 10, 1).pnlPct).toBe(0);
    });
  });

  it('maps sides to the orders that open and close them', () => {
    expect(entryOrderSide('LONG')).toBe('BUY');
    expect(exitOrderSide('LONG')).toBe('SELL');
    expect(entryOrderSide('SHORT')).toBe('SELL');
    expect(exitOrderSide('SHORT')).toBe('BUY');
  });

  it('maps entry signals to sides and ignores the rest', () => {
    expect(sideFromSignal('ENTER_LONG')).toBe('LONG');
    expect(sideFromSignal('ENTER_SHORT')).toBe('SHORT');
    expect(sideFromSignal('EXIT')).toBeNull();
    expect(sideFromSignal('NONE')).toBeNull();
  });

  it('marks open positions to market with the right sign', () => {
    expect(unrealizedPnl('LONG', 100, 120, 1)).toBe(20);
    expect(unrealizedPnl('SHORT', 100, 120, 1)).toBe(-20);
    expect(positionValue('LONG', 2, 50)).toBe(100);
    expect(positionValue('SHORT', 2, 50)).toBe(-100);
  });

  it('validates stop and target placement per side', () => {
    expect(isStopOnLosingSide('LONG', 100, 95)).toBe(true);
    expect(isStopOnLosingSide('LONG', 100, 105)).toBe(false);
    expect(isStopOnLosingSide('SHORT', 100, 105)).toBe(true);
    expect(isStopOnLosingSide('SHORT', 100, 95)).toBe(false);
    expect(isTargetOnWinningSide('LONG', 100, 110)).toBe(true);
    expect(isTargetOnWinningSide('SHORT', 100, 90)).toBe(true);
    expect(isTargetOnWinningSide('SHORT', 100, 110)).toBe(false);
  });
});
