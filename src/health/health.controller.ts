import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Connection } from 'mongoose';
import { RedisCacheService } from '../cache/redis-cache.service';
import { WorkerHeartbeatService } from '../control/worker-heartbeat.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly mongo: Connection,
    private readonly cache: RedisCacheService,
    private readonly worker: WorkerHeartbeatService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Dependency health: MongoDB (required), Redis (cache, fail-open) and the execution loop (503 when it stalled)',
  })
  async check(@Res({ passthrough: true }) res: Response) {
    const [mongo, redis] = await Promise.all([this.pingMongo(), this.cache.ping()]);
    // This process's own execution loop. Read-only: a health check never runs the strategy.
    const loop = this.worker.loopState();
    if (loop === 'stalled') {
      // The process answers but its loop stopped ticking: fail the host's health check so it
      // restarts the instance (Render does), instead of leaving a zombie that trades nothing.
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {
      // A deliberately disabled cache (REDIS_URL empty) is not a degradation.
      status: !mongo.ok || loop === 'stalled' ? 'down' : redis.ok || redis.status === 'disabled' ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      mongo,
      redis,
      worker: { loop, lastTickAt: this.worker.getLastTickAt(), instanceId: this.worker.instanceId },
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
