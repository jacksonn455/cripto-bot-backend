import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { redisConfig } from '../config/configuration';

/**
 * Thin wrapper around ioredis for report/chart caching. Every call is fail-open: if Redis is
 * down or unreachable, we log a warning and behave as a cache miss instead of throwing — the
 * same "never crash the app on an external dependency failure" posture used for Binance calls
 * elsewhere in this project. Caching here is a performance optimization, never a correctness
 * requirement, so degrading to "always hit Mongo" is always safe.
 */
@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  /** null when REDIS_URL is empty: cache disabled, every call is a miss (no reconnect noise). */
  private readonly client: Redis | null;

  constructor(
    @Inject(redisConfig.KEY)
    private readonly config: ReturnType<typeof redisConfig>,
  ) {
    if (!this.config.url) {
      this.client = null;
      this.logger.log('REDIS_URL is empty: cache disabled, reports are always read from Mongo');
      return;
    }
    this.client = new Redis(this.config.url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
    });
    this.client.on('error', (err: Error) => {
      this.logger.warn(`Redis connection error (falling back to no cache): ${err.message}`);
    });
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
    const start = Date.now();
    try {
      await this.client.ping();
      return { ok: true, latencyMs: Date.now() - start, status: this.client.status };
    } catch {
      return { ok: false, latencyMs: null, status: this.client.status };
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null;
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.logger.warn(`Cache GET failed for "${key}": ${(err as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn(`Cache SET failed for "${key}": ${(err as Error).message}`);
    }
  }

  /** Reads from cache, and on a miss computes + stores the value under the given TTL. */
  async getOrSet<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await factory();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  }

  /** Invalidates every cached key under a prefix (e.g. after a trade opens/closes) via SCAN, never KEYS. */
  async deleteByPrefix(prefix: string): Promise<void> {
    if (!this.client) return;
    try {
      const keys: string[] = [];
      const stream = this.client.scanStream({ match: `${prefix}*`, count: 100 });
      for await (const chunk of stream) keys.push(...(chunk as string[]));
      if (keys.length > 0) await this.client.del(...keys);
    } catch (err) {
      this.logger.warn(`Cache invalidation failed for prefix "${prefix}": ${(err as Error).message}`);
    }
  }
}
