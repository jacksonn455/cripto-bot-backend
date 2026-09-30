import { Global, Module } from '@nestjs/common';
import { RedisCacheService } from './redis-cache.service';

/** Global so any module (reports today, others later) can inject RedisCacheService directly. */
@Global()
@Module({
  providers: [RedisCacheService],
  exports: [RedisCacheService],
})
export class CacheModule {}
