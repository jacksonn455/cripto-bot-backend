import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { redisConfig } from '../config/configuration';

type RedisCacheConfig = Pick<ReturnType<typeof redisConfig>, 'url' | 'reportsTtlSeconds'> &
  Partial<ReturnType<typeof redisConfig>>;

const DEFAULTS = {
  connectTimeoutMs: 2_000,
  commandTimeoutMs: 500,
  maxReconnectAttempts: 10,
};
/** Backoff between reconnect attempts: 0.5s, 1s, 2s … capped at 30s (~2.5 min for 10 attempts). */
const MAX_BACKOFF_MS = 30_000;
/** After giving up, one lazy connection attempt at most this often (only when the cache is used). */
const REPROBE_INTERVAL_MS = 5 * 60_000;
/** Connection errors are logged at most this often, however many requests hit the outage. */
const ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * Thin wrapper around ioredis for report/chart caching. Every call is fail-open: if Redis is
 * down, slow or unreachable, it behaves as a cache miss instead of throwing — the same "never
 * crash the app on an external dependency failure" posture used for Binance calls elsewhere.
 * Caching here is a performance optimization, never a correctness requirement: nothing in
 * trading, risk or execution reads or writes Redis, so degrading to "always hit Mongo" is safe.
 *
 * Resource bounds while Redis is down: commands are never queued (offline queue off), each
 * command has a timeout, reconnection backs off and stops after REDIS_MAX_RECONNECT_ATTEMPTS
 * (no infinite loop), then at most one lazy re-probe every 5 minutes lets it recover on its own.
 */
@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  /** null when disabled (REDIS_ENABLED=false or REDIS_URL empty): every call is a miss, no connection. */
  private readonly client: Redis | null;
  private readonly settings: typeof DEFAULTS;
  private gaveUpAt: number | null = null;
  private lastErrorLogAt = 0;
  private wasReady = false;

  constructor(
    @Inject(redisConfig.KEY)
    private readonly config: RedisCacheConfig,
  ) {
    this.settings = {
      connectTimeoutMs: config.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      commandTimeoutMs: config.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
      maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULTS.maxReconnectAttempts,
    };

    if (config.enabled === false || !config.url) {
      this.client = null;
      this.logger.log(
        `[Redis] cache disabled (${config.enabled === false ? 'REDIS_ENABLED=false' : 'REDIS_URL is empty'}): reports are always read from Mongo`,
      );
      return;
    }

    this.client = new Redis(config.url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: this.settings.connectTimeoutMs,
      commandTimeout: this.settings.commandTimeoutMs,
      retryStrategy: (attempt) => this.retryDelay(attempt),
    });
    this.client.on('ready', () => {
      this.logger.log(this.wasReady || this.gaveUpAt ? '[Redis] reconnected - cache active again' : '[Redis] connected');
      this.wasReady = true;
      this.gaveUpAt = null;
    });
    this.client.on('error', (err: Error) => this.logUnavailable(err.message));
  }

  /** ioredis retryStrategy: a delay in ms, or null to stop reconnecting. Exposed for tests. */
  retryDelay(attempt: number): number | null {
    if (attempt > this.settings.maxReconnectAttempts) {
      if (this.gaveUpAt === null) {
        this.logger.warn(
          `[Redis] unavailable after ${this.settings.maxReconnectAttempts} reconnect attempts - giving up, ` +
            'using fallback (Mongo) and re-probing at most every 5 min',
        );
      }
      this.gaveUpAt = Date.now();
      return null;
    }
    return Math.min(250 * 2 ** attempt, MAX_BACKOFF_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    // quit() waits for a connection; while Redis is down/reconnecting it would hang shutdown.
    if (this.client.status === 'ready') {
      await this.client.quit().catch(() => undefined);
    } else {
      this.client.disconnect();
    }
  }

  /**
   * Commands fail fast (offline queue disabled) until the connection is ready — including right
   * after boot — and callers fall back to computing the value.
   */
  isReady(): boolean {
    return this.client?.status === 'ready';
  }

  /** For health checks: round-trip time, or null when Redis is unreachable. */
  async ping(): Promise<{ ok: boolean; latencyMs: number | null; status: string }> {
    if (!this.client) return { ok: false, latencyMs: null, status: 'disabled' };
    if (!this.usable()) return { ok: false, latencyMs: null, status: this.client.status };
    const start = Date.now();
    try {
      await this.client.ping();
      return { ok: true, latencyMs: Date.now() - start, status: this.client.status };
    } catch {
      return { ok: false, latencyMs: null, status: this.client.status };
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client || !this.usable()) return null;
    try {
      const raw = await this.client.get(key);
      this.logger.debug(`[Redis] cache ${raw ? 'hit' : 'miss'} ${key}`);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logUnavailable(`GET failed: ${(err as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client || !this.usable()) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logUnavailable(`SET failed: ${(err as Error).message}`);
    }
  }

  /**
   * Reads from cache, and on a miss computes + stores the value under the given TTL. Only cache
   * errors are swallowed: an error from `factory` (e.g. Mongo down) propagates untouched, so a
   * real failure is never masked as "no data".
   */
  async getOrSet<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await factory();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  }

  /** Invalidates every cached key under a prefix (e.g. after a trade opens/closes) via SCAN, never KEYS. */
  async deleteByPrefix(prefix: string): Promise<void> {
    if (!this.client || !this.usable()) return;
    try {
      const keys: string[] = [];
      const stream = this.client.scanStream({ match: `${prefix}*`, count: 100 });
      for await (const chunk of stream) keys.push(...(chunk as string[]));
      if (keys.length > 0) await this.client.del(...keys);
    } catch (err) {
      this.logUnavailable(`invalidation of "${prefix}*" failed: ${(err as Error).message}`);
    }
  }

  /**
   * Whether a command can be sent right now. Not ready = immediate miss, without an error per
   * request. After the reconnect budget is spent, kicks off one background re-probe per interval.
   */
  private usable(): boolean {
    if (!this.client) return false;
    if (this.client.status === 'ready') return true;
    if (this.client.status === 'end' && this.gaveUpAt !== null && Date.now() - this.gaveUpAt >= REPROBE_INTERVAL_MS) {
      this.gaveUpAt = Date.now();
      this.logger.log('[Redis] re-probing connection');
      this.client.connect().catch(() => undefined);
    }
    return false;
  }

  private logUnavailable(detail: string): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogAt = now;
    this.logger.warn(`[Redis] unavailable - using fallback (${detail})`);
  }
}
