import type { CandidateGate, SetupType } from '../../strategy/strategy.interface';
import type { CandidateFeatures } from '../candidate-features';
import type { CandidateAssessment } from './candidate-assessment.contract';

export const CANDIDATE_JUDGE = Symbol('CANDIDATE_JUDGE');

/**
 * off    = no judge runs; nothing is assessed (default).
 * shadow = the configured judge assesses every candidate and the assessment is stored on it, but
 *          nothing reads it for trading: decisions are exactly those of `off`.
 * (enforce is reserved for a later, separately validated step and is rejected by config validation.)
 */
export type JudgeMode = 'off' | 'shadow';
export const JUDGE_MODES: readonly JudgeMode[] = ['off', 'shadow'];

export type JudgeKind = 'noop' | 'baseline';
export const JUDGE_KINDS: readonly JudgeKind[] = ['noop', 'baseline'];

/** Everything a judge may look at: the candidate, its features, and what the deterministic rules said. */
export interface JudgeInput {
  candidateId: string;
  side: 'LONG' | 'SHORT';
  setupType: SetupType;
  features: CandidateFeatures;
  /** The strategy's gates. A judge meant to add information (e.g. an LLM) may choose not to read them. */
  deterministic: {
    gates: Array<{ gate: CandidateGate; ok: boolean }>;
    strategyAccepted: boolean;
  };
}

/** Offline-capable by design: the backtest assesses candidates in a batch, then simulates from stored results. */
export interface CandidateJudge {
  /** Stable identity + version, stored with every assessment (e.g. "baseline:v1"). */
  readonly id: string;
  assess(input: JudgeInput): Promise<CandidateAssessment>;
}
