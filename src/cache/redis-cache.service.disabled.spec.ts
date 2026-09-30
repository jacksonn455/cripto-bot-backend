import { RedisCacheService } from './redis-cache.service';

describe('RedisCacheService with REDIS_URL empty (cache disabled)', () => {
  const service = new RedisCacheService({ url: '', reportsTtlSeconds: 30 });

  it('never connects and behaves as a permanent cache miss', async () => {
    expect(service.isReady()).toBe(false);
    await service.set('k', { a: 1 }, 30);
    expect(await service.get('k')).toBeNull();
    await expect(service.deleteByPrefix('k')).resolves.toBeUndefined();
    expect(await service.getOrSet('k', 30, async () => 42)).toBe(42);
    expect(await service.ping()).toEqual({ ok: false, latencyMs: null, status: 'disabled' });
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});
