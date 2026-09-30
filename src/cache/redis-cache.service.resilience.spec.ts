import { Logger } from '@nestjs/common';
import { createServer, type Server, type Socket } from 'node:net';
import { RedisCacheService } from './redis-cache.service';

/**
 * A tiny RESP server that completes ioredis' handshake (INFO ready check, CLIENT SETINFO...) and
 * then never answers GET/SET: a Redis that is "up" but hung — the case a plain connection-error
 * test can't cover.
 */
function startHungRedis(): Promise<{ server: Server; url: string; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const parsed = parseCommand(buffer);
        if (!parsed) break;
        buffer = buffer.slice(parsed.consumed);
        const name = parsed.args[0]?.toUpperCase();
        if (name === 'GET' || name === 'SET' || name === 'SCAN') continue; // hang
        if (name === 'INFO') {
          const info = '# Server\r\nredis_version:7.2.0\r\nloading:0\r\n';
          socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
        } else if (name === 'PING') {
          socket.write('+PONG\r\n');
        } else {
          socket.write('+OK\r\n');
        }
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `redis://127.0.0.1:${port}`, sockets });
    });
  });
}

function parseCommand(buffer: string): { args: string[]; consumed: number } | null {
  if (!buffer.startsWith('*')) return null;
  let pos = buffer.indexOf('\r\n');
  if (pos < 0) return null;
  const count = Number(buffer.slice(1, pos));
  pos += 2;
  const args: string[] = [];
  for (let i = 0; i < count; i++) {
    const lenEnd = buffer.indexOf('\r\n', pos);
    if (lenEnd < 0) return null;
    const len = Number(buffer.slice(pos + 1, lenEnd));
    const start = lenEnd + 2;
    if (buffer.length < start + len + 2) return null;
    args.push(buffer.slice(start, start + len));
    pos = start + len + 2;
  }
  return { args, consumed: pos };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('RedisCacheService resilience', () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(String(args[0]));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('REDIS_ENABLED=false disables the cache even with a URL (no connection at all)', async () => {
    const service = new RedisCacheService({ enabled: false, url: 'redis://127.0.0.1:6379', reportsTtlSeconds: 30 });
    const factory = jest.fn().mockResolvedValue(7);

    await expect(service.getOrSet('k', 30, factory)).resolves.toBe(7);
    expect(await service.ping()).toEqual({ ok: false, latencyMs: null, status: 'disabled' });
    expect((service as unknown as { client: unknown }).client).toBeNull();
  });

  it('a hung Redis costs at most REDIS_COMMAND_TIMEOUT_MS per call, then falls back', async () => {
    const hung = await startHungRedis();
    const service = new RedisCacheService({ url: hung.url, reportsTtlSeconds: 30, commandTimeoutMs: 100 });
    try {
      await waitFor(() => service.isReady());
      const started = Date.now();

      await expect(service.getOrSet('k', 30, async () => 'fresh')).resolves.toBe('fresh');

      // GET timed out (100ms) and SET timed out (100ms): well under a second, never hanging.
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(warnings.some((w) => w.includes('[Redis] unavailable - using fallback'))).toBe(true);
    } finally {
      await service.onModuleDestroy();
      hung.sockets.forEach((s) => s.destroy());
      await new Promise((r) => hung.server.close(r));
    }
  });

  it('never masks a real application error: a failing factory still rejects', async () => {
    const service = new RedisCacheService({ url: '', reportsTtlSeconds: 30 });
    await expect(service.getOrSet('k', 30, () => Promise.reject(new Error('mongo down')))).rejects.toThrow('mongo down');
  });

  it('does not send commands (nor log per request) while Redis is not ready', async () => {
    const service = new RedisCacheService({ url: 'redis://127.0.0.1:1', reportsTtlSeconds: 30, maxReconnectAttempts: 0 });
    const client = (service as unknown as { client: { get: jest.Mock | ((...a: unknown[]) => unknown) } }).client;
    const getSpy = jest.spyOn(client as never, 'get' as never);

    for (let i = 0; i < 20; i++) await service.get('k');

    expect(getSpy).not.toHaveBeenCalled();
    // At most one throttled warning, not one per request.
    expect(warnings.filter((w) => w.includes('using fallback')).length).toBeLessThanOrEqual(1);
    await service.onModuleDestroy();
  });

  it('backs off exponentially and gives up after REDIS_MAX_RECONNECT_ATTEMPTS (no infinite loop)', async () => {
    const service = new RedisCacheService({ url: '', reportsTtlSeconds: 30, maxReconnectAttempts: 5 });

    expect([1, 2, 3, 4, 5].map((n) => service.retryDelay(n))).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(service.retryDelay(6)).toBeNull();
    expect(service.retryDelay(7)).toBeNull();
    // "Giving up" is logged once, not on every later attempt.
    expect(warnings.filter((w) => w.includes('giving up'))).toHaveLength(1);
  });

  it('caps the backoff at 30s', () => {
    const service = new RedisCacheService({ url: '', reportsTtlSeconds: 30, maxReconnectAttempts: 50 });
    expect(service.retryDelay(20)).toBe(30_000);
  });
});
