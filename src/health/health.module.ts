import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** RedisCacheService comes from the global CacheModule; the Mongo connection from DatabaseModule. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
