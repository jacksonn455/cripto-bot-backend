import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RedisCacheService } from '../cache/redis-cache.service';
import { redisConfig } from '../config/configuration';
import type { EquityCurveFilter } from './reports.interface';
import { EquitySnapshot, EquitySnapshotDocument } from './schemas/equity-snapshot.schema';

const CACHE_PREFIX = 'reports:equityCurve:';

@Injectable()
export class EquitySnapshotsService {
  constructor(
    @InjectModel(EquitySnapshot.name)
    private readonly model: Model<EquitySnapshotDocument>,
    private readonly cache: RedisCacheService,
    @Inject(redisConfig.KEY)
    private readonly cacheConfig: ReturnType<typeof redisConfig>,
  ) {}

  async insertMany(snapshots: Partial<EquitySnapshot>[]): Promise<void> {
    if (snapshots.length === 0) return;
    await this.model.insertMany(snapshots);
    // New snapshots invalidate every cached curve, not just this mode/runId — cheap at this scale.
    await this.cache.deleteByPrefix(CACHE_PREFIX);
  }

  async findCurve(query: EquityCurveFilter): Promise<EquitySnapshot[]> {
    const { mode, runId, from, to } = query;
    const key = `${CACHE_PREFIX}${mode ?? ''}:${runId ?? ''}:${from ?? ''}:${to ?? ''}`;
    return this.cache.getOrSet(key, this.cacheConfig.reportsTtlSeconds, async () => {
      const filter: Record<string, unknown> = {};
      if (mode) filter.mode = mode;
      if (runId) filter.runId = runId;
      if (from || to) {
        filter.timestamp = {
          ...(from ? { $gte: new Date(from) } : {}),
          ...(to ? { $lte: new Date(to) } : {}),
        };
      }
      return this.model.find(filter).sort({ timestamp: 1 }).lean();
    });
  }
}
