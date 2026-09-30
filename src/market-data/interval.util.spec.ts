import { intervalToMs } from './interval.util';

describe('intervalToMs', () => {
  it('converts minute/hour/day/week intervals', () => {
    expect(intervalToMs('1m')).toBe(60_000);
    expect(intervalToMs('15m')).toBe(15 * 60_000);
    expect(intervalToMs('1h')).toBe(3_600_000);
    expect(intervalToMs('4h')).toBe(4 * 3_600_000);
    expect(intervalToMs('1d')).toBe(86_400_000);
    expect(intervalToMs('1w')).toBe(604_800_000);
  });

  it('throws on an unsupported interval', () => {
    expect(() => intervalToMs('bogus')).toThrow(/Unsupported interval/);
  });
});
