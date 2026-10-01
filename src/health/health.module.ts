import { Module } from '@nestjs/common';
import { ControlModule } from '../control/control.module';
import { HealthController } from './health.controller';

/** RedisCacheService comes from the global CacheModule; the Mongo connection from DatabaseModule. */
@Module({ imports: [ControlModule], controllers: [HealthController] })
export class HealthModule {}
