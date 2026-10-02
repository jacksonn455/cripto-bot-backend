import type { Model, QueryFilter } from 'mongoose';
import type { CandidateRecord, ShadowOutcome } from './candidate.types';
import type { CandidateDocument, CandidateRecordDoc } from './schemas/candidate.schema';

export const CANDIDATE_LEDGER_STORE = Symbol('CANDIDATE_LEDGER_STORE');

/** Upper bound for one funnel/list read (the ledger grows by ~a dozen rows per symbol per month). */
export const MAX_LEDGER_READ = 50_000;

export interface CandidateQuery {
  mode?: string;
  runId?: string;
  symbol?: string;
  side?: 'LONG' | 'SHORT';
  setupType?: string;
  /** candleCloseTime bounds, epoch ms (inclusive). */
  from?: number;
  to?: number;
  limit?: number;
  /** Newest first by default. */
  skip?: number;
}

export interface CandidateLedgerStore {
  /** Inserts or overwrites (same key = same candle re-evaluated); shadow outcomes stored later are kept. */
  upsertMany(records: CandidateRecord[]): Promise<void>;
  find(query: CandidateQuery): Promise<CandidateRecord[]>;
  count(query: CandidateQuery): Promise<number>;
  /** Paper/live rows that have a stop but no CLOSED shadow outcome yet, oldest first. */
  findShadowPending(modes: string[], sinceCloseTime: number, limit: number): Promise<CandidateRecord[]>;
  setShadow(record: Pick<CandidateRecord, 'candidateId' | 'runId'>, shadow: ShadowOutcome): Promise<void>;
}

/** Document key: candidateId in paper/live, scoped by run in backtests. */
export function ledgerKey(r: Pick<CandidateRecord, 'candidateId' | 'runId'>): string {
  return r.runId ? `${r.runId}|${r.candidateId}` : r.candidateId;
}

export class MongoCandidateLedgerStore implements CandidateLedgerStore {
  constructor(private readonly model: Model<CandidateDocument>) {}

  async upsertMany(records: CandidateRecord[]): Promise<void> {
    if (records.length === 0) return;
    const ops = records.map((r) => ({
      // The upsert takes _id from the filter; it must not be in $set (immutable field).
      updateOne: { filter: { _id: ledgerKey(r) }, update: { $set: { ...r } }, upsert: true },
    }));
    // CandidateRecord's typed sub-objects (features, gates…) are stored as plain Objects in the schema.
    await this.model.bulkWrite(ops as unknown as Parameters<Model<CandidateDocument>['bulkWrite']>[0], { ordered: false });
  }

  async find(query: CandidateQuery): Promise<CandidateRecord[]> {
    const docs = await this.model
      .find(toFilter(query))
      .sort({ candleCloseTime: -1, _id: 1 })
      .skip(query.skip ?? 0)
      .limit(Math.min(query.limit ?? MAX_LEDGER_READ, MAX_LEDGER_READ))
      .lean();
    return docs.map(toRecord);
  }

  count(query: CandidateQuery): Promise<number> {
    return this.model.countDocuments(toFilter(query));
  }

  async findShadowPending(modes: string[], sinceCloseTime: number, limit: number): Promise<CandidateRecord[]> {
    const docs = await this.model
      .find({
        mode: { $in: modes },
        stopLoss: { $exists: true },
        candleCloseTime: { $gte: sinceCloseTime },
        $or: [{ shadow: { $exists: false } }, { 'shadow.status': 'OPEN' }],
      })
      .sort({ candleCloseTime: 1 })
      .limit(limit)
      .lean();
    return docs.map(toRecord);
  }

  async setShadow(record: Pick<CandidateRecord, 'candidateId' | 'runId'>, shadow: ShadowOutcome): Promise<void> {
    await this.model.updateOne({ _id: ledgerKey(record) }, { $set: { shadow } });
  }
}

function toFilter(q: CandidateQuery): QueryFilter<CandidateDocument> {
  const filter: QueryFilter<CandidateDocument> = {};
  if (q.mode) filter.mode = q.mode;
  if (q.runId) filter.runId = q.runId;
  if (q.symbol) filter.symbol = q.symbol.toUpperCase();
  if (q.side) filter.side = q.side;
  if (q.setupType) filter.setupType = q.setupType;
  if (q.from !== undefined || q.to !== undefined) {
    filter.candleCloseTime = { ...(q.from !== undefined ? { $gte: q.from } : {}), ...(q.to !== undefined ? { $lte: q.to } : {}) };
  }
  return filter;
}

function toRecord(doc: CandidateRecordDoc): CandidateRecord {
  const { _id: _key, ...rest } = doc as CandidateRecordDoc & { __v?: number };
  delete (rest as { __v?: number }).__v;
  return rest as unknown as CandidateRecord;
}

/** Tests and the default when no store is wired. */
export class InMemoryCandidateLedgerStore implements CandidateLedgerStore {
  readonly rows = new Map<string, CandidateRecord>();

  upsertMany(records: CandidateRecord[]): Promise<void> {
    for (const r of records) {
      const previous = this.rows.get(ledgerKey(r));
      this.rows.set(ledgerKey(r), { ...previous, ...r });
    }
    return Promise.resolve();
  }

  find(q: CandidateQuery): Promise<CandidateRecord[]> {
    const all = [...this.rows.values()]
      .filter((r) => matches(r, q))
      .sort((a, b) => b.candleCloseTime - a.candleCloseTime);
    return Promise.resolve(all.slice(q.skip ?? 0, (q.skip ?? 0) + Math.min(q.limit ?? MAX_LEDGER_READ, MAX_LEDGER_READ)));
  }

  count(q: CandidateQuery): Promise<number> {
    return Promise.resolve([...this.rows.values()].filter((r) => matches(r, q)).length);
  }

  findShadowPending(modes: string[], since: number, limit: number): Promise<CandidateRecord[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => modes.includes(r.mode) && r.stopLoss !== undefined && r.candleCloseTime >= since)
        .filter((r) => !r.shadow || r.shadow.status === 'OPEN')
        .sort((a, b) => a.candleCloseTime - b.candleCloseTime)
        .slice(0, limit),
    );
  }

  setShadow(record: Pick<CandidateRecord, 'candidateId' | 'runId'>, shadow: ShadowOutcome): Promise<void> {
    const row = this.rows.get(ledgerKey(record));
    if (row) row.shadow = shadow;
    return Promise.resolve();
  }
}

function matches(r: CandidateRecord, q: CandidateQuery): boolean {
  return (
    (!q.mode || r.mode === q.mode) &&
    (!q.runId || r.runId === q.runId) &&
    (!q.symbol || r.symbol === q.symbol.toUpperCase()) &&
    (!q.side || r.side === q.side) &&
    (!q.setupType || r.setupType === q.setupType) &&
    (q.from === undefined || r.candleCloseTime >= q.from) &&
    (q.to === undefined || r.candleCloseTime <= q.to)
  );
}
