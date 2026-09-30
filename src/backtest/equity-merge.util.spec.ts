import { mergeEquityCurves } from './equity-merge.util';

const p = (timestamp: number, equity: number, openPositions = 0) => ({ timestamp, balance: equity, equity, openPositions });

describe('mergeEquityCurves', () => {
  it('returns a single curve untouched', () => {
    const curve = [p(1, 100), p(2, 110)];
    expect(mergeEquityCurves([curve], [100])).toBe(curve);
  });

  it('sums curves on the union of timestamps, carrying the last point and the starting capital', () => {
    const a = [p(1, 5000), p(3, 5100, 1)];
    const b = [p(2, 4900, 1), p(3, 4950)];
    expect(mergeEquityCurves([a, b], [5000, 5000])).toEqual([
      p(1, 10_000), // b not started yet: its 5000 of capital
      { timestamp: 2, balance: 9900, equity: 9900, openPositions: 1 },
      { timestamp: 3, balance: 10_050, equity: 10_050, openPositions: 1 },
    ]);
  });
});
