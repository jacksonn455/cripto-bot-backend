import { checkIntraCandleExit } from './intra-candle-exit.util';

describe('checkIntraCandleExit', () => {
  describe('LONG (default side)', () => {
    it('stops out when the low touches the stop', () => {
      expect(checkIntraCandleExit({ stopLoss: 95 }, { high: 101, low: 95 })).toEqual({ exitPrice: 95, reason: 'SL' });
    });

    it('takes profit when the high touches the target', () => {
      expect(checkIntraCandleExit({ stopLoss: 95, takeProfit: 110 }, { high: 111, low: 99 })).toEqual({
        exitPrice: 110,
        reason: 'TP',
      });
    });

    it('assumes the stop first when the candle touches both', () => {
      expect(checkIntraCandleExit({ stopLoss: 95, takeProfit: 110 }, { high: 111, low: 94 })?.reason).toBe('SL');
    });

    it('does nothing inside the range', () => {
      expect(checkIntraCandleExit({ stopLoss: 95, takeProfit: 110 }, { high: 105, low: 96 })).toBeNull();
    });
  });

  describe('SHORT', () => {
    it('stops out when the high touches the stop (above entry)', () => {
      expect(checkIntraCandleExit({ side: 'SHORT', stopLoss: 105 }, { high: 105.5, low: 99 })).toEqual({
        exitPrice: 105,
        reason: 'SL',
      });
    });

    it('takes profit when the low touches the target (below entry)', () => {
      expect(checkIntraCandleExit({ side: 'SHORT', stopLoss: 105, takeProfit: 90 }, { high: 101, low: 89 })).toEqual({
        exitPrice: 90,
        reason: 'TP',
      });
    });

    it('assumes the stop first when the candle touches both (conservative)', () => {
      expect(
        checkIntraCandleExit({ side: 'SHORT', stopLoss: 105, takeProfit: 90 }, { high: 106, low: 89 })?.reason,
      ).toBe('SL');
    });

    it('is not triggered by a low below a short stop (that is the profitable direction)', () => {
      expect(checkIntraCandleExit({ side: 'SHORT', stopLoss: 105 }, { high: 100, low: 80 })).toBeNull();
    });
  });
});
