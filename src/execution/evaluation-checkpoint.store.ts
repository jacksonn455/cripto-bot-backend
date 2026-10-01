import { Model } from 'mongoose';
import { EvaluationCheckpointDocument } from './schemas/evaluation-checkpoint.schema';

export const EVALUATION_CHECKPOINT_STORE = Symbol('EVALUATION_CHECKPOINT_STORE');

/** A claim older than this is considered abandoned (its process died mid-evaluation) and can be retaken. */
export const CLAIM_LEASE_MS = 5 * 60_000;

export interface ClaimResult {
  /** This process now owns the evaluation of the candle. */
  claimed: boolean;
  /** closeTime of the last fully evaluated candle before this one (null = never evaluated). */
  previousCloseTime: number | null;
}

/**
 * Exactly-once evaluation of each closed candle, across restarts and overlapping processes:
 * claim → evaluate → commit, or release on failure so the next tick retries the same candle.
 */
export interface EvaluationCheckpointStore {
  claim(key: string, closeTime: number, owner: string, now?: Date): Promise<ClaimResult>;
  commit(key: string, closeTime: number, owner: string, now?: Date): Promise<void>;
  release(key: string, closeTime: number, owner: string): Promise<void>;
}

const DUPLICATE_KEY = 11000;

export class MongoEvaluationCheckpointStore implements EvaluationCheckpointStore {
  constructor(private readonly model: Model<EvaluationCheckpointDocument>) {}

  async claim(key: string, closeTime: number, owner: string, now = new Date()): Promise<ClaimResult> {
    const leaseExpired = new Date(now.getTime() - CLAIM_LEASE_MS);
    try {
      // Matches only if the candle is newer than the committed one AND nobody holds a live claim
      // on it. No match → the upsert tries to insert the same _id → duplicate key → not claimed.
      const before = await this.model
        .findOneAndUpdate(
          {
            _id: key,
            $and: [
              { $or: [{ lastCloseTime: { $exists: false } }, { lastCloseTime: { $lt: closeTime } }] },
              {
                $or: [
                  { claimCloseTime: { $exists: false } },
                  { claimCloseTime: { $ne: closeTime } },
                  { claimedAt: { $lt: leaseExpired } },
                ],
              },
            ],
          },
          { $set: { claimCloseTime: closeTime, claimedBy: owner, claimedAt: now } },
          { upsert: true, returnDocument: 'before' },
        )
        .lean();
      return { claimed: true, previousCloseTime: before?.lastCloseTime ?? null };
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) {
        const doc = await this.model.findById(key).lean();
        return { claimed: false, previousCloseTime: doc?.lastCloseTime ?? null };
      }
      throw err;
    }
  }

  async commit(key: string, closeTime: number, owner: string, now = new Date()): Promise<void> {
    await this.model.updateOne(
      { _id: key },
      { $max: { lastCloseTime: closeTime }, $set: { evaluatedAt: now } },
    );
    await this.model.updateOne(
      { _id: key, claimCloseTime: closeTime, claimedBy: owner },
      { $unset: { claimCloseTime: 1, claimedBy: 1, claimedAt: 1 } },
    );
  }

  async release(key: string, closeTime: number, owner: string): Promise<void> {
    await this.model.updateOne(
      { _id: key, claimCloseTime: closeTime, claimedBy: owner },
      { $unset: { claimCloseTime: 1, claimedBy: 1, claimedAt: 1 } },
    );
  }
}

/** Same semantics without a database — unit tests and the ExecutionService default. */
export class InMemoryEvaluationCheckpointStore implements EvaluationCheckpointStore {
  private readonly docs = new Map<string, { lastCloseTime?: number; claim?: { closeTime: number; owner: string; at: number } }>();

  async claim(key: string, closeTime: number, owner: string, now = new Date()): Promise<ClaimResult> {
    const doc = this.docs.get(key) ?? {};
    const previousCloseTime = doc.lastCloseTime ?? null;
    const newer = previousCloseTime === null || previousCloseTime < closeTime;
    const liveClaim = doc.claim?.closeTime === closeTime && now.getTime() - doc.claim.at < CLAIM_LEASE_MS;
    if (!newer || liveClaim) return { claimed: false, previousCloseTime };
    this.docs.set(key, { ...doc, claim: { closeTime, owner, at: now.getTime() } });
    return { claimed: true, previousCloseTime };
  }

  async commit(key: string, closeTime: number, owner: string): Promise<void> {
    const doc = this.docs.get(key) ?? {};
    const claim = doc.claim?.closeTime === closeTime && doc.claim.owner === owner ? undefined : doc.claim;
    this.docs.set(key, { lastCloseTime: Math.max(doc.lastCloseTime ?? closeTime, closeTime), claim });
  }

  async release(key: string, closeTime: number, owner: string): Promise<void> {
    const doc = this.docs.get(key);
    if (doc?.claim?.closeTime === closeTime && doc.claim.owner === owner) this.docs.set(key, { ...doc, claim: undefined });
  }
}
