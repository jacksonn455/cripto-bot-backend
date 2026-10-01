import { InMemoryEvaluationSnapshotStore } from './evaluation-snapshot.store';
import { evaluationSnapshotStoreContract } from './evaluation-snapshot.store.contract-spec';

describe('InMemoryEvaluationSnapshotStore', () => {
  evaluationSnapshotStoreContract(() => new InMemoryEvaluationSnapshotStore());
});
