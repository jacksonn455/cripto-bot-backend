import type { CandidateGate } from '../../strategy/strategy.interface';
import { ASSESSMENT_SCHEMA_VERSION, type CandidateAssessment } from './candidate-assessment.contract';
import type { CandidateJudge, JudgeInput } from './candidate-judge.interface';

type Warning = CandidateAssessment['warnings'][number];

const WARNING_BY_GATE: Record<CandidateGate, Warning> = {
  SIDE: 'SIDE_DISABLED',
  REGIME: 'COUNTER_REGIME',
  RSI: 'RSI_OUT_OF_BAND',
  ADX: 'WEAK_TREND',
  INDICATORS: 'MISSING_INDICATORS',
};

/**
 * Deterministic control arm, no LLM: restates the strategy's own rules in the judge contract.
 * verdict = the strategy's decision; setupQuality = share of gates passed (ordinal, deliberately
 * not tuned); warnings = the failed gates. Any future judge has to beat this to be worth its cost.
 */
export class BaselineJudge implements CandidateJudge {
  readonly id = 'baseline:v1';

  assess(input: JudgeInput): Promise<CandidateAssessment> {
    const { gates, strategyAccepted } = input.deterministic;
    const passed = gates.filter((g) => g.ok).length;
    const okOf = (gate: CandidateGate) => gates.find((g) => g.gate === gate)?.ok;
    const f = input.features;
    const keyFactors: CandidateAssessment['keyFactors'] = [];
    const factor = (feature: string, value: number | null, ok: boolean | undefined) => {
      if (value !== null && ok !== undefined) keyFactors.push({ feature, value, effect: ok ? 'SUPPORTS' : 'AGAINST' });
    };
    factor('regime.distance', f.regime.distance, okOf('REGIME'));
    factor('rsi', f.rsi, okOf('RSI'));
    factor('adx', f.adx, okOf('ADX'));

    return Promise.resolve({
      schemaVersion: ASSESSMENT_SCHEMA_VERSION,
      candidateId: input.candidateId,
      verdict: strategyAccepted ? 'APPROVE' : 'REJECT',
      setupQuality: gates.length ? Math.round((100 * passed) / gates.length) : 0,
      // No pre-registered regime rule exists yet; inventing thresholds here would be an untested variant.
      regime: 'UNCERTAIN',
      keyFactors,
      warnings: gates.filter((g) => !g.ok).map((g) => WARNING_BY_GATE[g.gate]),
      rationale: strategyAccepted
        ? 'baseline: all deterministic gates passed'
        : `baseline: failed ${gates.filter((g) => !g.ok).map((g) => g.gate).join(', ')}`,
    });
  }
}
