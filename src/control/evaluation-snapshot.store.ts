import { Model } from 'mongoose';
import { EvaluationSnapshotDocument, EvaluationSnapshotRecord } from './schemas/evaluation-snapshot.schema';

export const EVALUATION_SNAPSHOT_STORE = Symbol('EVALUATION_SNAPSHOT_STORE');

export type EvaluationSource = 'cycle' | 'reconciliation';

/**
 * What the worker did with the evaluated candle. INFORMATIONAL = re-run after a restart on a candle
 * already handled before it: nothing was (or could be) traded by that run.
 */
export type DecisionOutcome = 'ENTERED' | 'NOT_ENTERED' | 'EXITED' | 'IN_POSITION' | 'SKIPPED' | 'INFORMATIONAL';

export interface ConditionResult {
  key: 'cross' | 'regime' | 'rsi';
  ok: boolean;
  /** The value compared (EMA fast, higher-timeframe close, RSI); null when it couldn't be computed yet. */
  value: number | null;
  /** What it was compared against, e.g. "EMA50 64000.00", "EMA200 (4h) 61000.00", "45 a 70". */
  threshold: string;
  message: string;
}

export interface EvaluationSnapshot {
  mode: string;
  symbol: string;
  timeframe: string;
  regimeTimeframe: string;
  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedAt: Date;
  source: EvaluationSource;
  /** HOLD / ENTER_LONG / ENTER_SHORT / EXIT / SKIP, as in the `bot.cycle` event. */
  action: string;
  reason: string;
  price?: number;
  indicators: Record<string, number | undefined>;
  /** Side whose entry rules were judged; absent with an open position or without enough history. */
  side?: 'LONG' | 'SHORT';
  conditions?: ConditionResult[];
  decision: { outcome: DecisionOutcome; reason: string };
}

export interface StoredSnapshot {
  /** null while the symbol has never been evaluated (it may still carry an error). */
  snapshot: EvaluationSnapshot | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/**
 * Latest evaluation per mode + symbol, kept across restarts. A `reconciliation` snapshot is written
 * only when nothing is stored yet for that candle, so it never replaces the real (`cycle`) one;
 * neither kind ever replaces a snapshot of a newer candle.
 */
export interface EvaluationSnapshotStore {
  get(mode: string, symbol: string): Promise<StoredSnapshot | null>;
  list(mode: string): Promise<Array<StoredSnapshot & { symbol: string }>>;
  /** false = an existing snapshot was kept (same candle already stored, or a newer one). */
  save(snapshot: EvaluationSnapshot): Promise<boolean>;
  recordError(mode: string, symbol: string, message: string, at?: Date): Promise<void>;
  clearError(mode: string, symbol: string): Promise<void>;
}

const DUPLICATE_KEY = 11000;
const OPTIONAL_FIELDS = ['price', 'side', 'conditions'] as const;
const keyOf = (mode: string, symbol: string) => `${mode}:${symbol}`;

/** Filter of the documents a snapshot may overwrite (upsert target). */
function replaceableFilter(s: EvaluationSnapshot) {
  const candle = s.source === 'cycle' ? { $lte: s.candleCloseTime } : { $lt: s.candleCloseTime };
  return { _id: keyOf(s.mode, s.symbol), $or: [{ candleCloseTime: { $exists: false } }, { candleCloseTime: candle }] };
}

function toStored(doc: EvaluationSnapshotRecord): StoredSnapshot & { symbol: string } {
  const snapshot: EvaluationSnapshot | null =
    doc.candleCloseTime === undefined || !doc.evaluatedAt
      ? null
      : {
          mode: doc.mode,
          symbol: doc.symbol,
          timeframe: doc.timeframe ?? '',
          regimeTimeframe: doc.regimeTimeframe ?? '',
          candleOpenTime: doc.candleOpenTime ?? doc.candleCloseTime,
          candleCloseTime: doc.candleCloseTime,
          evaluatedAt: new Date(doc.evaluatedAt),
          source: (doc.source as EvaluationSource) ?? 'cycle',
          action: doc.action ?? '',
          reason: doc.reason ?? '',
          price: doc.price,
          indicators: doc.indicators ?? {},
          side: doc.side as EvaluationSnapshot['side'],
          conditions: doc.conditions as unknown as ConditionResult[] | undefined,
          decision: (doc.decision as EvaluationSnapshot['decision']) ?? { outcome: 'NOT_ENTERED', reason: '' },
        };
  return {
    symbol: doc.symbol,
    snapshot,
    lastError: doc.lastError ?? null,
    lastErrorAt: doc.lastErrorAt ? new Date(doc.lastErrorAt) : null,
  };
}

export class MongoEvaluationSnapshotStore implements EvaluationSnapshotStore {
  constructor(private readonly model: Model<EvaluationSnapshotDocument>) {}

  async get(mode: string, symbol: string): Promise<StoredSnapshot | null> {
    const doc = await this.model.findById(keyOf(mode, symbol)).lean();
    if (!doc) return null;
    const { snapshot, lastError, lastErrorAt } = toStored(doc);
    return { snapshot, lastError, lastErrorAt };
  }

  async list(mode: string): Promise<Array<StoredSnapshot & { symbol: string }>> {
    const docs = await this.model.find({ mode }).lean();
    return docs.map(toStored);
  }

  async save(s: EvaluationSnapshot): Promise<boolean> {
    try {
      // No match (same candle already stored by a reconciliation, or a newer candle) → the upsert
      // tries to insert the same _id → duplicate key → the stored snapshot is kept.
      // Optional fields this snapshot lacks must not survive from the previous one (e.g. the
      // conditions of a candle evaluated before a position opened).
      const absent = OPTIONAL_FIELDS.filter((k) => s[k] === undefined);
      await this.model.updateOne(
        replaceableFilter(s),
        // A stored evaluation means the market data came through: any previous error is over.
        {
          $set: { ...s },
          $unset: Object.fromEntries([...absent, 'lastError', 'lastErrorAt'].map((k) => [k, 1])),
        },
        { upsert: true },
      );
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === DUPLICATE_KEY) return false;
      throw err;
    }
  }

  async recordError(mode: string, symbol: string, message: string, at = new Date()): Promise<void> {
    await this.model.updateOne(
      { _id: keyOf(mode, symbol) },
      { $set: { mode, symbol, lastError: message.slice(0, 500), lastErrorAt: at } },
      { upsert: true },
    );
  }

  async clearError(mode: string, symbol: string): Promise<void> {
    await this.model.updateOne(
      { _id: keyOf(mode, symbol), lastError: { $exists: true } },
      { $unset: { lastError: 1, lastErrorAt: 1 } },
    );
  }
}

/** Same semantics without a database — unit tests and the ExecutionService default. */
export class InMemoryEvaluationSnapshotStore implements EvaluationSnapshotStore {
  private readonly docs = new Map<string, StoredSnapshot & { symbol: string; mode: string }>();

  async get(mode: string, symbol: string): Promise<StoredSnapshot | null> {
    const doc = this.docs.get(keyOf(mode, symbol));
    return doc ? { snapshot: doc.snapshot, lastError: doc.lastError, lastErrorAt: doc.lastErrorAt } : null;
  }

  async list(mode: string): Promise<Array<StoredSnapshot & { symbol: string }>> {
    return [...this.docs.values()]
      .filter((d) => d.mode === mode)
      .map(({ symbol, snapshot, lastError, lastErrorAt }) => ({ symbol, snapshot, lastError, lastErrorAt }));
  }

  async save(s: EvaluationSnapshot): Promise<boolean> {
    const current = this.docs.get(keyOf(s.mode, s.symbol))?.snapshot;
    if (current) {
      const stored = current.candleCloseTime;
      if (s.source === 'cycle' ? stored > s.candleCloseTime : stored >= s.candleCloseTime) return false;
    }
    this.docs.set(keyOf(s.mode, s.symbol), { mode: s.mode, symbol: s.symbol, snapshot: { ...s }, lastError: null, lastErrorAt: null });
    return true;
  }

  async recordError(mode: string, symbol: string, message: string, at = new Date()): Promise<void> {
    const doc = this.docs.get(keyOf(mode, symbol));
    this.docs.set(keyOf(mode, symbol), { mode, symbol, snapshot: doc?.snapshot ?? null, lastError: message, lastErrorAt: at });
  }

  async clearError(mode: string, symbol: string): Promise<void> {
    const doc = this.docs.get(keyOf(mode, symbol));
    if (doc) this.docs.set(keyOf(mode, symbol), { ...doc, lastError: null, lastErrorAt: null });
  }
}
