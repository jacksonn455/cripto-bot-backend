import { createHash } from 'node:crypto';

/** Deterministic hash of a params object, independent of key order — used to dedupe/count runs. */
export function computeParamsHash(params: Record<string, unknown>): string {
  const sortedJson = JSON.stringify(sortKeysDeep(params));
  return createHash('sha256').update(sortedJson).digest('hex').slice(0, 16);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}
