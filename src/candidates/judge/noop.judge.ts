import { ASSESSMENT_SCHEMA_VERSION, type CandidateAssessment } from './candidate-assessment.contract';
import type { CandidateJudge, JudgeInput } from './candidate-judge.interface';

/**
 * Never objects and carries no information: APPROVE for everything, a constant score. Combined with
 * the deterministic decision in any way, it leaves that decision unchanged — the reference for
 * "the judge layer itself changes nothing".
 */
export class NoopJudge implements CandidateJudge {
  readonly id = 'noop:v1';

  assess(input: JudgeInput): Promise<CandidateAssessment> {
    return Promise.resolve({
      schemaVersion: ASSESSMENT_SCHEMA_VERSION,
      candidateId: input.candidateId,
      verdict: 'APPROVE',
      // Constant and meaningless: a no-op judge has no opinion on quality.
      setupQuality: 50,
      regime: 'UNCERTAIN',
      keyFactors: [],
      warnings: [],
      rationale: 'noop judge: no opinion, never objects',
    });
  }
}
