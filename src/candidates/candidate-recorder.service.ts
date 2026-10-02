import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { candidatesConfig } from '../config/configuration';
import type { Candle } from '../exchange/types/candle.type';
import { buildCandidateFeatures, featureParamsFrom, type CandidateFeatures } from './candidate-features';
import { CANDIDATE_LEDGER_STORE, InMemoryCandidateLedgerStore, type CandidateLedgerStore } from './candidate-ledger.store';
import { buildCandidateRecords, type CandidateRecordsInput } from './candidate-records';
import type { CandidateRecord, StoredAssessment } from './candidate.types';
import { validateAssessment } from './judge/candidate-assessment.contract';
import { CANDIDATE_JUDGE, type CandidateJudge } from './judge/candidate-judge.interface';
import { NoopJudge } from './judge/noop.judge';

export type RecordCandidatesInput = Omit<CandidateRecordsInput, 'features'> & {
  /** Strategy.getParams() of the instance that produced the signal. */
  strategyParams?: Record<string, number>;
  /** Exactly the windows the strategy evaluated. */
  candles: Candle[];
  regimeCandles?: Candle[];
};

/**
 * Writes the candidate ledger for one evaluated candle and, in AI_JUDGE_MODE=shadow, the configured
 * judge's assessment of each candidate. Called by the execution loop AFTER the candle's decision is
 * final (orders included), so neither the ledger nor the judge can influence it; failures are logged
 * and swallowed.
 */
@Injectable()
export class CandidateRecorderService {
  private readonly logger = new Logger(CandidateRecorderService.name);

  constructor(
    @Inject(candidatesConfig.KEY) private readonly config: ReturnType<typeof candidatesConfig>,
    @Optional() @Inject(CANDIDATE_LEDGER_STORE) private readonly store: CandidateLedgerStore = new InMemoryCandidateLedgerStore(),
    @Optional() @Inject(CANDIDATE_JUDGE) private readonly judge: CandidateJudge = new NoopJudge(),
  ) {}

  get enabled(): boolean {
    return this.config.ledgerEnabled;
  }

  async record(input: RecordCandidatesInput): Promise<CandidateRecord[]> {
    if (!this.enabled || !input.signal.candidates?.length) return [];
    try {
      const records = buildCandidateRecords({ ...input, features: this.features(input) });
      if (this.config.judgeMode === 'shadow') {
        for (const r of records) r.assessment = await this.assess(r);
      }
      await this.store.upsertMany(records);
      return records;
    } catch (err) {
      this.logger.warn(`candidate_ledger_failed symbol=${input.symbol} error="${(err as Error).message}"`);
      return [];
    }
  }

  private features(input: RecordCandidatesInput): CandidateFeatures | null {
    const params = featureParamsFrom(input.strategyParams);
    if (!params || input.candles.length === 0) return null;
    try {
      return buildCandidateFeatures(input.candles, input.regimeCandles, params);
    } catch {
      return null;
    }
  }

  /** Shadow only: stored for later evaluation, never returned to the caller's decision path. */
  private async assess(record: CandidateRecord): Promise<StoredAssessment> {
    const started = Date.now();
    const base = { judgeId: this.judge.id, judgeMode: 'shadow' as const, assessedAt: new Date(started) };
    if (!record.features) {
      return { ...base, latencyMs: 0, valid: false, errors: ['no features to assess'] };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.judge.assess({
          candidateId: record.candidateId,
          side: record.side,
          setupType: record.setupType,
          features: record.features,
          deterministic: { gates: record.gates, strategyAccepted: record.strategyDecision === 'ACCEPTED' },
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`judge timed out after ${this.config.judgeTimeoutMs}ms`)), this.config.judgeTimeoutMs);
        }),
      ]);
      const check = validateAssessment(raw, { candidateId: record.candidateId, features: record.features });
      return { ...base, latencyMs: Date.now() - started, valid: check.valid, errors: check.errors, assessment: check.assessment };
    } catch (err) {
      return { ...base, latencyMs: Date.now() - started, valid: false, errors: [], error: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
