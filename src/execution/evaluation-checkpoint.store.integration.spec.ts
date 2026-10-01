import mongoose from 'mongoose';
import { MongoEvaluationCheckpointStore } from './evaluation-checkpoint.store';
import { EvaluationCheckpoint, EvaluationCheckpointSchema } from './schemas/evaluation-checkpoint.schema';

/**
 * Runs the claim/commit/release queries against a real MongoDB — only when MONGO_TEST_URI is set
 * (e.g. mongodb://localhost:27017 from docker-compose). Never falls back to MONGO_URI: that may be
 * the live PAPER database. Uses a throwaway database and drops it afterwards.
 */
const URI = process.env.MONGO_TEST_URI;
const run = URI ? describe : describe.skip;

run('MongoEvaluationCheckpointStore (real MongoDB)', () => {
  let conn: mongoose.Connection;
  let store: MongoEvaluationCheckpointStore;
  const key = 'PAPER:BTCUSDT:1h';

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI!, { dbName: `checkpoint-spec-${process.pid}` }).asPromise();
    store = new MongoEvaluationCheckpointStore(conn.model(EvaluationCheckpoint.name, EvaluationCheckpointSchema) as never);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  it('claims once, refuses a second process, and remembers the commit across "restarts"', async () => {
    await expect(store.claim(key, 1_000, 'A')).resolves.toEqual({ claimed: true, previousCloseTime: null });
    await expect(store.claim(key, 1_000, 'B')).resolves.toEqual({ claimed: false, previousCloseTime: null });

    await store.commit(key, 1_000, 'A');
    await expect(store.claim(key, 1_000, 'B')).resolves.toEqual({ claimed: false, previousCloseTime: 1_000 });

    await expect(store.claim(key, 2_000, 'B')).resolves.toEqual({ claimed: true, previousCloseTime: 1_000 });
  });

  it('a released claim can be retaken, and an abandoned one expires', async () => {
    await store.release(key, 2_000, 'B');
    await expect(store.claim(key, 2_000, 'C', new Date())).resolves.toMatchObject({ claimed: true });
    // C "died" holding the claim; 6 minutes later D takes it over.
    await expect(store.claim(key, 2_000, 'D', new Date(Date.now() + 6 * 60_000))).resolves.toMatchObject({ claimed: true });
  });
});
