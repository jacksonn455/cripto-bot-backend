export interface DeliveryOptions {
  /** Per attempt. */
  timeoutMs: number;
  /** Total attempts including the first one. */
  maxAttempts: number;
  /** A 429 asking to wait longer than this is not retried (we'd rather drop than queue). */
  maxRetryDelayMs: number;
  /** Values that must never appear in an error message (tokens, webhook URLs). */
  secrets: string[];
}

export type DeliveryOutcome =
  | { ok: true; status: number; attempts: number }
  | {
      ok: false;
      status?: number;
      attempts: number;
      error: string;
      /** 401/403/404: the credentials or the webhook itself are wrong, retrying later won't help. */
      permanent: boolean;
    };

const BASE_BACKOFF_MS = 500;
const MAX_ERROR_DETAIL = 200;

/**
 * POSTs JSON with a timeout per attempt and a bounded retry: only on 429 (honoring the API's
 * retry_after when short enough), 5xx and connection errors. A timeout is NOT retried — the
 * request may have been delivered, and a duplicated trade message is worse than a missing one.
 */
export async function deliverJson(url: string, payload: unknown, opts: DeliveryOptions): Promise<DeliveryOutcome> {
  let lastError = 'no attempt made';
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const isLast = attempt === opts.maxAttempts;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };

      const bodyText = await res.text().catch(() => '');
      const body = parseJson(bodyText);
      lastStatus = res.status;
      lastError = `HTTP ${res.status}${describeBody(body)}`;

      if (res.status === 429) {
        const waitMs = retryAfterMs(res.headers, body);
        if (!isLast && waitMs <= opts.maxRetryDelayMs) {
          await sleep(waitMs);
          continue;
        }
        lastError = `rate limited (retry after ${Math.round(waitMs)}ms)`;
        break;
      }
      if (res.status >= 500 && !isLast) {
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }
      break;
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        lastError = `timeout after ${opts.timeoutMs}ms`;
        break;
      }
      lastError = `network error: ${e.message}`;
      if (!isLast) {
        await sleep(BASE_BACKOFF_MS * attempt);
        continue;
      }
    }
  }

  return {
    ok: false,
    status: lastStatus,
    attempts: opts.maxAttempts,
    error: redact(lastError, opts.secrets),
    permanent: lastStatus === 401 || lastStatus === 403 || lastStatus === 404,
  };
}

/** Removes every secret (and any URL embedding one) from a message before it is logged. */
export function redact(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** "https://discord.com/api/webhooks/123/abc" -> "discord.com/…/123" — enough to tell webhooks apart. */
export function maskWebhookUrl(url: string): string {
  const match = /^https?:\/\/([^/]+)\/.*\/webhooks\/(\d+)\//.exec(url);
  return match ? `${match[1]}/…/${match[2]}` : '[webhook]';
}

function retryAfterMs(headers: Headers, body: unknown): number {
  // Discord: { retry_after: seconds } ; Telegram: { parameters: { retry_after: seconds } }.
  const b = body as { retry_after?: unknown; parameters?: { retry_after?: unknown } } | undefined;
  const fromBody = Number(b?.retry_after ?? b?.parameters?.retry_after);
  if (Number.isFinite(fromBody) && fromBody >= 0) return fromBody * 1000;
  const fromHeader = Number(headers.get('retry-after'));
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader * 1000;
  return BASE_BACKOFF_MS;
}

function describeBody(body: unknown): string {
  const b = body as { message?: unknown; description?: unknown } | undefined;
  const detail = typeof b?.message === 'string' ? b.message : typeof b?.description === 'string' ? b.description : '';
  return detail ? `: ${detail.slice(0, MAX_ERROR_DETAIL)}` : '';
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
