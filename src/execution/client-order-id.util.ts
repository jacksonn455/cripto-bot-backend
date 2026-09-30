import { createHash } from 'node:crypto';

/**
 * Deterministic clientOrderId so retries/reconnects never double-place the same order
 * (Binance dedupes by clientOrderId within a short window, and it's also how we
 * recognize "is this order mine" during reconciliation).
 */
export function generateClientOrderId(
  mode: string,
  symbol: string,
  candleTime: number,
  purpose: 'ENTRY' | 'STOP' | 'EXIT',
): string {
  const raw = `${mode}:${symbol}:${candleTime}:${purpose}`;
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 24);
  return `bot_${purpose.slice(0, 1)}_${hash}`;
}
