import { z } from 'zod';
import type { CandidateFeatures } from '../candidate-features';

export const ASSESSMENT_SCHEMA_VERSION = '1';

export const ASSESSMENT_VERDICTS = ['APPROVE', 'REJECT', 'ABSTAIN'] as const;
export const ASSESSMENT_REGIMES = ['TRENDING', 'RANGING', 'HIGH_VOL', 'LOW_VOL', 'UNCERTAIN'] as const;
/** Closed list: a judge flags known conditions, it doesn't invent new categories. */
export const ASSESSMENT_WARNINGS = [
  'COUNTER_REGIME',
  'RSI_OUT_OF_BAND',
  'WEAK_TREND',
  'SIDE_DISABLED',
  'MISSING_INDICATORS',
  'EXTENDED_FROM_EMA',
  'HIGH_VOLATILITY',
] as const;

/**
 * What any judge — deterministic today, an LLM later — returns for one candidate. Deliberately
 * NOT in the contract: side, stop loss / stop distance, take profit, size, leverage, risk or
 * exposure limits, position count, pauses, exits. A judge can only express an opinion on a
 * candidate the deterministic system already produced; everything that bounds risk stays in
 * RiskManager and the strategy. (A tighter AI stop would even *increase* size under fixed-risk
 * sizing, which is why the stop is not negotiable here.)
 *
 * `setupQuality` is an ORDINAL score (higher = judged better), never a probability: it is only
 * trusted after calibration shows it ranks shadow outcomes.
 */
export const CandidateAssessmentSchema = z.object({
  schemaVersion: z.literal(ASSESSMENT_SCHEMA_VERSION),
  candidateId: z.string().min(1),
  verdict: z.enum(ASSESSMENT_VERDICTS),
  setupQuality: z.number().int().min(0).max(100),
  regime: z.enum(ASSESSMENT_REGIMES),
  keyFactors: z
    .array(
      z.object({
        /** A key of CandidateFeatures (dot path for nested ones, e.g. "regime.distance"). */
        feature: z.string(),
        /** The value as the judge read it — checked against the input to catch made-up numbers. */
        value: z.number(),
        effect: z.enum(['SUPPORTS', 'AGAINST', 'NEUTRAL']),
      }),
    )
    .max(10),
  warnings: z.array(z.enum(ASSESSMENT_WARNINGS)).max(10),
  rationale: z.string().max(300),
});

export type CandidateAssessment = z.infer<typeof CandidateAssessmentSchema>;

export interface AssessmentValidation {
  valid: boolean;
  errors: string[];
  assessment?: CandidateAssessment;
}

/**
 * Schema check plus grounding checks: the assessment is about this candidate, and every key factor
 * names a real feature with (within `relTolerance`) the value the judge was given. A failing
 * assessment is stored for analysis but must never count as an opinion.
 */
export function validateAssessment(
  raw: unknown,
  expected: { candidateId: string; features: CandidateFeatures },
  relTolerance = 0.01,
): AssessmentValidation {
  const parsed = CandidateAssessmentSchema.safeParse(raw);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const a = parsed.data;
  const errors: string[] = [];
  if (a.candidateId !== expected.candidateId) errors.push(`candidateId ${a.candidateId} != ${expected.candidateId}`);
  for (const f of a.keyFactors) {
    const actual = featureValue(expected.features, f.feature);
    if (actual === undefined) errors.push(`keyFactor "${f.feature}" is not an input feature`);
    else if (actual === null) errors.push(`keyFactor "${f.feature}" had no value in the input`);
    else if (Math.abs(f.value - actual) > relTolerance * Math.max(Math.abs(actual), 1e-9)) {
      errors.push(`keyFactor "${f.feature}"=${f.value} does not match the input (${actual})`);
    }
  }
  return { valid: errors.length === 0, errors, assessment: a };
}

/** Numeric feature by dot path; undefined = no such numeric feature. */
export function featureValue(features: CandidateFeatures, path: string): number | null | undefined {
  let node: unknown = features;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(key in node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'number' || node === null ? node : undefined;
}
