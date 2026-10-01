/** CORS_ORIGINS="https://a.vercel.app, http://localhost:3000" → trimmed, de-duplicated, no trailing "/". Empty = CORS off. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins = raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set(origins)];
}
