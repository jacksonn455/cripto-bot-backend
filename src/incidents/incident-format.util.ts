/**
 * Formatting + sanitization for incident notices. Everything that leaves the process in a Discord
 * or Telegram message goes through sanitizeForAlert: logs keep the full technical detail.
 */

const MAX_ALERT_TEXT = 300;

const REDACTIONS: Array<[RegExp, string]> = [
  // Discord/Telegram webhook & bot URLs (they embed the token).
  [/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\S+/gi, '[webhook]'],
  [/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, 'https://api.telegram.org/bot[token]'],
  // Connection strings: keep scheme + host only (drops user:password, db, query).
  [/\b(mongodb(?:\+srv)?|rediss?|postgres(?:ql)?|amqps?):\/\/(?:[^@\s/]*@)?([^/\s?,]+)[^\s,]*/gi, '$1://$2'],
  // Any remaining user:password@ in a URL.
  [/\/\/[^@\s/]+:[^@\s/]+@/g, '//***@'],
  // Bearer tokens first (otherwise "Authorization: Bearer x" would only mask the word "Bearer").
  [/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer ***'],
  // Query/header style secrets.
  [/\b(signature|api[_-]?key|apikey|secret|token|password|passwd|pwd|x-mbx-apikey)(["'\s]*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1$2***'],
  [/\b(authorization)(["'\s]*[:=]\s*["']?)(?!Bearer \*\*\*)[^\s"'&,;]+/gi, '$1$2***'],
  // Long opaque blobs (keys, tokens, hashes).
  [/\b[A-Za-z0-9_\-+/]{40,}={0,2}/g, '[redacted]'],
];

/** One line, no stack trace, no secrets, bounded length. */
export function sanitizeForAlert(raw: unknown, max = MAX_ALERT_TEXT): string {
  const text =
    raw instanceof Error
      ? `${raw.name === 'Error' ? '' : `${raw.name}: `}${raw.message}`
      : typeof raw === 'object' && raw !== null
        ? JSON.stringify(raw)
        : String(raw ?? '');
  let out = text.split('\n')[0].trim();
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** "01/10/2026 03:17:42 (GMT-3)" in the configured zone. */
export function formatClock(value: Date | string | number, timeZone: string): string {
  const date = new Date(value);
  const text = new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  return `${text.replace(',', '')} (${offset ?? timeZone})`;
}

/** "45s", "7m 30s", "2h 14m", "1d 3h". */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
