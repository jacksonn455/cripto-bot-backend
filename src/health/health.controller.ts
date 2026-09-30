import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Connection } from 'mongoose';
import { RedisCacheService } from '../cache/redis-cache.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    private readonly cache: RedisCacheService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Dependency health: MongoDB (required) and Redis (cache, fail-open: the app works without it)',
  })
  async check() {
    const [mongo, redis] = await Promise.all([this.pingMongo(), this.cache.ping()]);
    return {
      // A deliberately disabled cache (REDIS_URL empty) is not a degradation.
      status: mongo.ok ? (redis.ok || redis.status === 'disabled' ? 'ok' : 'degraded') : 'down',
      uptimeSeconds: Math.round(process.uptime()),
      mongo,
      redis,
    };
  }

  private async pingMongo(): Promise<{ ok: boolean; latencyMs: number | null }> {
    const start = Date.now();
    try {
      if (!this.mongo.db) throw new Error('not connected');
      await this.mongo.db.admin().ping();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: null };
    }
  }
}
