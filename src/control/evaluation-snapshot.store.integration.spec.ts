import mongoose from 'mongoose';
import { MongoEvaluationSnapshotStore } from './evaluation-snapshot.store';
import { evaluationSnapshotStoreContract } from './evaluation-snapshot.store.contract-spec';
import { EvaluationSnapshotRecord, EvaluationSnapshotSchema } from './schemas/evaluation-snapshot.schema';

/**
 * Same contract as the in-memory store, against a real MongoDB — only when MONGO_TEST_URI is set.
 * Never falls back to MONGO_URI (it may be the live PAPER database). Throwaway database, dropped after.
 */
const URI = process.env.MONGO_TEST_URI;
const run = URI ? describe : describe.skip;

run('MongoEvaluationSnapshotStore (real MongoDB)', () => {
  let conn: mongoose.Connection;
  let model: mongoose.Model<unknown>;

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI!, { dbName: `snapshot-spec-${process.pid}` }).asPromise();
    model = conn.model(EvaluationSnapshotRecord.name, EvaluationSnapshotSchema) as never;
  });

  afterEach(async () => {
    await model.deleteMany({});
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  evaluationSnapshotStoreContract(() => new MongoEvaluationSnapshotStore(model as never));
});
