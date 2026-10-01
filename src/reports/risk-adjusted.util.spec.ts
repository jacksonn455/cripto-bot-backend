import {
  computeRiskAdjusted,
  dailyEquity,
  deflatedSharpe,
  expectedMaxSharpe,
  harveyLiuHaircut,
  probabilisticSharpe,
} from './risk-adjusted.util';
import { kurtosis, normalCdf, normalInv, skewness } from './stats.util';

const DAY = 86_400_000;

describe('stats helpers', () => {
  it('normal CDF and its inverse match known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
    expect(normalInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalInv(0.01)).toBeCloseTo(-2.326348, 5);
    expect(normalInv(normalCdf(0.3))).toBeCloseTo(0.3, 5);
  });

  it('skewness is 0 and kurtosis 1 for a symmetric two-point sample', () => {
    expect(skewness([-1, 1, -1, 1])).toBeCloseTo(0);
    expect(kurtosis([-1, 1, -1, 1])).toBeCloseTo(1);
  });
});

describe('computeRiskAdjusted (daily equity curve)', () => {
  it('keeps the last equity of each UTC day, starting from the initial balance', () => {
    const curve = [
      { timestamp: 0, equity: 101 },
      { timestamp: 3_600_000, equity: 102 },
      { timestamp: DAY, equity: 99 },
    ];
    expect(dailyEquity(curve, 100)).toEqual([100, 102, 99]);
  });

  it('returns null with fewer than 3 daily returns', () => {
    expect(computeRiskAdjusted([{ timestamp: 0, equity: 101 }], 100)).toBeNull();
  });

  it('annualizes with 365 days and measures the drawdown on the daily curve', () => {
    // +1%, -1%, +1%, -1%, ... over 10 days, then +5%.
    const equities: number[] = [];
    let e = 100;
    for (let i = 0; i < 10; i++) {
      e *= i % 2 === 0 ? 1.01 : 0.99;
      equities.push(e);
    }
    equities.push(e * 1.05);
    const curve = equities.map((equity, i) => ({ timestamp: i * DAY, equity }));
    const m = computeRiskAdjusted(curve, 100)!;
    expect(m.days).toBe(11);
    expect(m.totalReturn).toBeCloseTo(equities[equities.length - 1] / 100 - 1);
    expect(m.sharpeAnnualized).toBeCloseTo(m.sharpeDaily * Math.sqrt(365));
    expect(m.maxDrawdown).toBeCloseTo(0.01, 3);
    expect(m.calmar).toBeCloseTo(m.cagr / m.maxDrawdown);
    expect(m.probabilisticSharpe).toBeGreaterThan(0.5);
    expect(m.sortinoAnnualized).toBeGreaterThan(m.sharpeAnnualized);
  });
});

describe('Probabilistic and Deflated Sharpe (Bailey & López de Prado)', () => {
  it('PSR is 0.5 when the Sharpe equals the benchmark', () => {
    expect(probabilisticSharpe(0.1, 0.1, 500, 0, 3)).toBeCloseTo(0.5);
  });

  it('reproduces the numerical example of "The Deflated Sharpe Ratio" (2014): DSR ≈ 0.90', () => {
    // N = 100 trials, V[SR] = 0.5 (annualized), T = 1250 daily returns, annualized SR = 2.5,
    // skewness −3, kurtosis 10. The paper annualizes with 250 days; the formula is unit-free.
    const perYear = 250;
    const { deflatedSharpe: dsr, expectedMaxSharpeDaily } = deflatedSharpe(
      { sharpeDaily: 2.5 / Math.sqrt(perYear), days: 1250, skewness: -3, kurtosis: 10 },
      100,
      0.5 / perYear,
    );
    expect(expectedMaxSharpeDaily * Math.sqrt(perYear)).toBeCloseTo(1.79, 1);
    expect(dsr).toBeCloseTo(0.9, 2);
  });

  it('with one trial there is no luck benchmark', () => {
    expect(expectedMaxSharpe(1, 0.5)).toBe(0);
  });

  it('the luck benchmark grows with the number of trials', () => {
    expect(expectedMaxSharpe(1000, 0.01)).toBeGreaterThan(expectedMaxSharpe(10, 0.01));
  });
});

describe('Harvey & Liu haircut (Bonferroni)', () => {
  it('discounts more with more trials', () => {
    const few = harveyLiuHaircut(1.5, 3 * 365, 2);
    const many = harveyLiuHaircut(1.5, 3 * 365, 100);
    expect(few.haircut).toBeGreaterThan(0);
    expect(many.haircut).toBeGreaterThan(few.haircut);
    expect(many.haircutSharpe).toBeLessThan(few.haircutSharpe);
  });

  it('takes the whole Sharpe when the adjusted p-value reaches 1', () => {
    expect(harveyLiuHaircut(0.2, 90, 50)).toEqual({ haircutSharpe: 0, haircut: 1 });
  });

  it('a single trial only converts the Sharpe back and forth (no haircut)', () => {
    expect(harveyLiuHaircut(1.2, 2 * 365, 1).haircut).toBeCloseTo(0, 6);
  });
});
