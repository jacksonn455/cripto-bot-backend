import type { RiskDecision } from '../risk/risk.interface';
import type { Signal } from '../strategy/strategy.interface';
import type { CandidateFeatures } from './candidate-features';
import { candidateId, opportunityId } from './candidate-id';
import type { CandidateFinalAction, CandidateRecord, CandidateStage } from './candidate.types';

export interface CandidateRecordsInput {
  mode: string;
  runId?: string;
  symbol: string;
  timeframe: string;
  regimeTimeframe?: string;
  /** The strategy's signal for this candle; only its `candidates` become records. */
  signal: Signal;
  features: CandidateFeatures | null;
  /** RiskManager's decision for the accepted candidate (absent = risk was never reached). */
  risk?: RiskDecision;
  riskIfResumed?: RiskDecision;
  pause: { paused: boolean; reason?: string };
  /** ENTERED once the entry order went through; FAILED = it threw after risk approved. */
  entry?: 'ENTERED' | 'FAILED';
  evaluatedAt: Date;
}

/**
 * Pure: one ledger record per setup the strategy saw trigger on this candle, accepted or not,
 * with the stage where it left the funnel. Same function for live, paper and backtest.
 */
export function buildCandidateRecords(input: CandidateRecordsInput): CandidateRecord[] {
  return (input.signal.candidates ?? []).map((c) => {
    const identity = {
      symbol: input.symbol,
      timeframe: input.timeframe,
      candleCloseTime: input.signal.candleTime,
      setupType: c.setupType,
      side: c.side,
    };
    const strategyRejectedAt = c.accepted ? undefined : c.gates.find((g) => !g.ok)?.gate;
    const risk = c.accepted ? input.risk : undefined;
    const { rejectedAt, finalAction } = c.accepted
      ? stageAfterStrategy(risk, input.entry)
      : { rejectedAt: strategyRejectedAt ?? null, finalAction: 'REJECTED' as const };
    return {
      candidateId: candidateId(input.mode, identity),
      opportunityId: opportunityId(identity),
      mode: input.mode,
      ...(input.runId ? { runId: input.runId } : {}),
      symbol: input.symbol,
      timeframe: input.timeframe,
      ...(input.regimeTimeframe ? { regimeTimeframe: input.regimeTimeframe } : {}),
      candleCloseTime: input.signal.candleTime,
      side: c.side,
      setupType: c.setupType,
      strategy: input.signal.strategy,
      price: c.price,
      ...(c.stopLoss !== undefined ? { stopLoss: c.stopLoss } : {}),
      strategyDecision: c.accepted ? 'ACCEPTED' : 'REJECTED',
      gates: c.gates,
      ...(strategyRejectedAt ? { strategyRejectedAt } : {}),
      features: input.features,
      ...(risk ? { risk: riskResult(risk) } : {}),
      ...(risk?.rejectReason === 'BOT_PAUSED' && input.riskIfResumed
        ? { riskIfResumed: { approved: Boolean(input.riskIfResumed.approved && input.riskIfResumed.qty), ...reason(input.riskIfResumed) } }
        : {}),
      botPaused: input.pause.paused,
      ...(input.pause.reason ? { pauseReason: input.pause.reason } : {}),
      rejectedAt,
      finalAction,
      evaluatedAt: input.evaluatedAt,
    };
  });
}

function stageAfterStrategy(
  risk: RiskDecision | undefined,
  entry: CandidateRecordsInput['entry'],
): { rejectedAt: CandidateStage | null; finalAction: CandidateFinalAction } {
  if (!risk) return { rejectedAt: 'EXECUTION', finalAction: 'ENTRY_FAILED' };
  // Execution treats an approval without a quantity as a veto, so does the ledger.
  if (!risk.approved || !risk.qty) {
    return { rejectedAt: risk.rejectReason === 'BOT_PAUSED' ? 'PAUSE' : 'RISK', finalAction: 'REJECTED' };
  }
  if (entry === 'ENTERED') return { rejectedAt: null, finalAction: 'ENTERED' };
  return { rejectedAt: 'EXECUTION', finalAction: 'ENTRY_FAILED' };
}

function riskResult(d: RiskDecision) {
  return { approved: Boolean(d.approved && d.qty), ...reason(d), ...(d.qty ? { qty: d.qty } : {}) };
}

function reason(d: RiskDecision) {
  return d.rejectReason ? { rejectReason: d.rejectReason } : d.approved && !d.qty ? { rejectReason: 'NO_QUANTITY' } : {};
}
