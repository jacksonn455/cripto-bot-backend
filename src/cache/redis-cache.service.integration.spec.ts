import Redis from 'ioredis';
import { RedisCacheService } from './redis-cache.service';

/**
 * Runs against the real Redis at REDIS_URL (default localhost:6379) when it's reachable, and is
 * skipped otherwise. Uses its own key prefix and cleans up after itself.
 */
const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const PREFIX = `test:cache-spec:${process.pid}:`;

async function redisReachable(): Promise<boolean> {
  const probe = new Redis(URL, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1000, retryStrategy: () => null });
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

function makeService(url: string): RedisCacheService {
  return new RedisCacheService({ url, reportsTtlSeconds: 30 });
}

describe('RedisCacheService (real Redis)', () => {
  let available = false;
  let service: RedisCacheService;
  let raw: Redis;

  const itIfRedis = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (!available) {
        console.warn(`Redis not reachable at ${URL}; skipping "${name}"`);
        return;
      }
      await fn();
    });

  beforeAll(async () => {
    available = await redisReachable();
    if (!available) return;
    service = makeService(URL);
    raw = new Redis(URL);
    // Offline queue is disabled: commands before 'ready' are (intentionally) cache misses.
    for (let i = 0; i < 50 && !service.isReady(); i++) await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(async () => {
    if (!available) return;
    await service.deleteByPrefix(PREFIX);
    await service.onModuleDestroy();
    raw.disconnect();
  });

  itIfRedis('reports health with latency', async () => {
    const health = await service.ping();
    expect(health).toMatchObject({ ok: true, status: 'ready' });
    expect(health.latencyMs).not.toBeNull();
  });

  itIfRedis('computes once, then serves from cache with the given TTL', async () => {
    const factory = jest.fn().mockResolvedValue({ value: 42, when: '2026-09-29T00:00:00.000Z' });

    const first = await service.getOrSet(`${PREFIX}a`, 30, factory);
    const second = await service.getOrSet(`${PREFIX}a`, 30, factory);

    expect(first).toEqual({ value: 42, when: '2026-09-29T00:00:00.000Z' });
    expect(second).toEqual(first);
    expect(factory).toHaveBeenCalledTimes(1);
    const ttl = await raw.ttl(`${PREFIX}a`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  itIfRedis('expires keys after the TTL', async () => {
    const factory = jest.fn().mockResolvedValue('v');
    await service.getOrSet(`${PREFIX}short`, 1, factory);
    await new Promise((r) => setTimeout(r, 1500));
    await service.getOrSet(`${PREFIX}short`, 1, factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  itIfRedis('invalidates every key under a prefix (SCAN, not KEYS) and leaves others alone', async () => {
    await service.set(`${PREFIX}reports:1`, 1, 30);
    await service.set(`${PREFIX}reports:2`, 2, 30);
    await service.set(`${PREFIX}other`, 3, 30);

    await service.deleteByPrefix(`${PREFIX}reports:`);

    expect(await raw.exists(`${PREFIX}reports:1`, `${PREFIX}reports:2`)).toBe(0);
    expect(await raw.exists(`${PREFIX}other`)).toBe(1);
  });
});

describe('RedisCacheService fail-open (Redis down)', () => {
  it('behaves as a cache miss, reports unhealthy, never throws and shuts down cleanly', async () => {
    // Nothing listens on port 1: every command fails fast (offline queue disabled).
    const service = makeService('redis://127.0.0.1:1');
    const factory = jest.fn().mockResolvedValue('fresh');

    await expect(service.getOrSet('k', 30, factory)).resolves.toBe('fresh');
    await expect(service.getOrSet('k', 30, factory)).resolves.toBe('fresh');
    await expect(service.deleteByPrefix('k')).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
    expect((await service.ping()).ok).toBe(false);

    // Must not hang while the client is reconnecting.
    await service.onModuleDestroy();
  });
});
