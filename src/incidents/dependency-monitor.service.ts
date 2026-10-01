import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { RedisCacheService } from '../cache/redis-cache.service';
import { IncidentService } from './incident.service';

const CHECK_INTERVAL_MS = 60_000;
const PING_TIMEOUT_MS = 10_000;

/**
 * Checks the backend's own dependencies once a minute and feeds the results to IncidentService
 * (read-only pings — nothing here touches trading). MongoDB is critical (the loop can't record
 * anything without it): it alerts on the 2nd consecutive failed check. Redis is a fail-open
 * cache: it uses the normal threshold and is skipped when deliberately disabled.
 */
@Injectable()
export class DependencyMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DependencyMonitorService.name);
  private timer?: ReturnType<typeof setInterval>;
  private mongoFailures = 0;

  constructor(
    @InjectConnection() private readonly mongo: Connection,
    private readonly cache: RedisCacheService,
    private readonly incidents: IncidentService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<void> {
    try {
      await this.checkMongo();
      await this.checkRedis();
    } catch (err) {
      this.logger.error(`Dependency check failed unexpectedly: ${(err as Error).message}`);
    }
  }

  private async checkMongo(): Promise<void> {
    try {
      if (!this.mongo.db) throw new Error(`not connected (readyState=${this.mongo.readyState})`);
      await withTimeout(this.mongo.db.admin().ping(), PING_TIMEOUT_MS, 'MongoDB ping timed out');
      this.mongoFailures = 0;
      this.incidents.reportSuccess('DATABASE');
    } catch (err) {
      this.mongoFailures += 1;
      // One failed ping can be a blip during a driver reconnect; two in a row (≈1 min) is an outage.
      if (this.mongoFailures < 2) {
        this.logger.warn(`MongoDB health check failed (1st): ${(err as Error).message}`);
        return;
      }
      this.incidents.reportFailure({
        key: 'DATABASE',
        type: 'DATABASE_ERROR',
        component: 'MongoDB',
        error: err,
        critical: true,
      });
    }
  }

  private async checkRedis(): Promise<void> {
    const redis = await this.cache.ping();
    if (redis.status === 'disabled') return;
    if (redis.ok) {
      this.incidents.reportSuccess('REDIS');
      return;
    }
    this.incidents.reportFailure({
      key: 'REDIS',
      type: 'REDIS_ERROR',
      component: 'Redis (cache de relatórios)',
      error: `Redis indisponível (status=${redis.status}); relatórios leem direto do MongoDB`,
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
