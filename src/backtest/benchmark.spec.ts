import { buildBenchmark } from './backtest.service';

describe('buildBenchmark (buy-and-hold over the same period)', () => {
  it('computes each symbol return and the equal-allocation average', () => {
    const benchmark = buildBenchmark(
      new Map([
        ['BTCUSDT', { start: 100, end: 110 }],
        ['ETHUSDT', { start: 50, end: 45 }],
      ]),
    );
    expect(benchmark!.bySymbol.BTCUSDT).toEqual({ startPrice: 100, endPrice: 110, returnPct: 10 });
    expect(benchmark!.bySymbol.ETHUSDT.returnPct).toBeCloseTo(-10);
    expect(benchmark!.buyAndHoldPct).toBeCloseTo(0);
  });

  it('skips symbols without prices and returns undefined when none has them', () => {
    expect(buildBenchmark(new Map([['BTCUSDT', {}]]))).toBeUndefined();
    const partial = buildBenchmark(new Map([['BTCUSDT', { start: 100, end: 120 }], ['XUSDT', {}]]));
    expect(Object.keys(partial!.bySymbol)).toEqual(['BTCUSDT']);
    expect(partial!.buyAndHoldPct).toBeCloseTo(20);
  });
});
