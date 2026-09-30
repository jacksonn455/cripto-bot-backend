const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  // Approximation (Binance has no fixed month length); only used for cache-coverage estimates.
  M: 2_592_000_000,
};

export function intervalToMs(interval: string): number {
  const unit = interval.slice(-1);
  const amount = parseInt(interval.slice(0, -1), 10);
  const unitMs = UNIT_MS[unit];
  if (!unitMs || Number.isNaN(amount)) {
    throw new Error(`Unsupported interval: ${interval}`);
  }
  return amount * unitMs;
}
