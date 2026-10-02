import type { Candle } from '../../exchange/types/candle.type';

const H = 3_600_000;

/** Deterministic PRNG (mulberry32): same seed → same series, so tests never flake. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Closed candles of a random walk with slowly switching drift (so trends, crosses and regime flips
 * all happen), oldest first. `hours` = candle length.
 */
export function syntheticCandles(opts: { count: number; seed: number; hours?: number; start?: number; symbol?: string }): Candle[] {
  const rand = rng(opts.seed);
  const step = (opts.hours ?? 1) * H;
  const start = opts.start ?? Date.UTC(2025, 0, 1);
  const out: Candle[] = [];
  let price = 100;
  let drift = 0;
  for (let i = 0; i < opts.count; i++) {
    if (i % 60 === 0) drift = (rand() - 0.5) * 0.004;
    const open = price;
    const close = open * (1 + drift + (rand() - 0.5) * 0.02);
    const high = Math.max(open, close) * (1 + rand() * 0.006);
    const low = Math.min(open, close) * (1 - rand() * 0.006);
    const openTime = start + i * step;
    out.push({
      symbol: opts.symbol ?? 'BTCUSDT',
      interval: `${opts.hours ?? 1}h`,
      openTime,
      open,
      high,
      low,
      close,
      volume: 100 + rand() * 50,
      closeTime: openTime + step - 1,
      quoteVolume: 0,
      trades: 0,
      isClosed: true,
    });
    price = close;
  }
  return out;
}

/** The higher-timeframe candles built from `candles` (groups of `factor`), like 4h from 1h. */
export function aggregateCandles(candles: Candle[], factor: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    out.push({
      ...group[0],
      interval: `${factor}h`,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      closeTime: group[group.length - 1].closeTime,
      volume: group.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}
