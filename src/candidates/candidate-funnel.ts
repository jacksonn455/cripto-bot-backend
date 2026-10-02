import type { CandidateRecord, CandidateStage } from './candidate.types';
import { STRATEGY_STAGES } from './candidate.types';

/** Order of the funnel: strategy gates, then risk (pause is RiskManager's first check), then execution. */
export const FUNNEL_ORDER: readonly CandidateStage[] = [...STRATEGY_STAGES, 'PAUSE', 'RISK', 'EXECUTION'];

export interface ShadowStats {
  /** Candidates with a CLOSED shadow outcome. */
  measured: number;
  wins: number;
  losses: number;
  /** Shadow still running at the end of the data, or not computed yet. */
  pending: number;
  avgR: number | null;
  sumR: number;
}

export interface FunnelStep {
  step: CandidateStage;
  /** Candidates reaching this step. */
  entering: number;
  rejected: number;
  remaining: number;
  /** Shadow outcomes of the candidates rejected HERE: was the gate right to remove them? */
  rejectedShadow: ShadowStats;
}

export interface CandidateFunnel {
  total: number;
  bySide: Record<'LONG' | 'SHORT', number>;
  bySetup: Record<string, number>;
  strategyAccepted: number;
  steps: FunnelStep[];
  entered: number;
  /** RiskManager veto reasons other than the pause (counts). */
  riskRejectReasons: Record<string, number>;
  paused: {
    /** Candidates on a candle while the bot was paused (whatever stage they stopped at). */
    candidatesWhileBotPaused: number;
    /** Strategy-accepted candidates vetoed with BOT_PAUSED: entries the pause prevented. */
    blockedByPause: number;
    /** Of those, how many RiskManager would have approved right after a manual resume. */
    wouldTradeIfResumed: number;
    blockedShadow: ShadowStats;
  };
  shadow: {
    entered: ShadowStats;
    rejected: ShadowStats;
    rejectedWinners: number;
    rejectedLosers: number;
  };
}

/** Pure aggregation of ledger rows (any mode, symbol or run the caller filtered). */
export function summarizeFunnel(records: readonly CandidateRecord[]): CandidateFunnel {
  const bySide = { LONG: 0, SHORT: 0 };
  const bySetup: Record<string, number> = {};
  const riskRejectReasons: Record<string, number> = {};
  for (const r of records) {
    bySide[r.side]++;
    bySetup[r.setupType] = (bySetup[r.setupType] ?? 0) + 1;
    if (r.rejectedAt === 'RISK' && r.risk?.rejectReason) {
      riskRejectReasons[r.risk.rejectReason] = (riskRejectReasons[r.risk.rejectReason] ?? 0) + 1;
    }
  }

  let remaining = records.length;
  const steps: FunnelStep[] = FUNNEL_ORDER.map((step) => {
    const removed = records.filter((r) => r.rejectedAt === step);
    const entering = remaining;
    remaining -= removed.length;
    return { step, entering, rejected: removed.length, remaining, rejectedShadow: shadowStats(removed) };
  });

  const rejected = records.filter((r) => r.finalAction !== 'ENTERED');
  const blocked = records.filter((r) => r.rejectedAt === 'PAUSE');
  return {
    total: records.length,
    bySide,
    bySetup,
    strategyAccepted: records.filter((r) => r.strategyDecision === 'ACCEPTED').length,
    steps,
    entered: records.filter((r) => r.finalAction === 'ENTERED').length,
    riskRejectReasons,
    paused: {
      candidatesWhileBotPaused: records.filter((r) => r.botPaused).length,
      blockedByPause: blocked.length,
      wouldTradeIfResumed: blocked.filter((r) => r.riskIfResumed?.approved).length,
      blockedShadow: shadowStats(blocked),
    },
    shadow: {
      entered: shadowStats(records.filter((r) => r.finalAction === 'ENTERED')),
      rejected: shadowStats(rejected),
      rejectedWinners: rejected.filter((r) => r.shadow?.status === 'CLOSED' && r.shadow.outcome === 'WIN').length,
      rejectedLosers: rejected.filter((r) => r.shadow?.status === 'CLOSED' && r.shadow.outcome === 'LOSS').length,
    },
  };
}

export function shadowStats(records: readonly CandidateRecord[]): ShadowStats {
  const closed = records.filter((r) => r.shadow?.status === 'CLOSED');
  const sumR = closed.reduce((s, r) => s + r.shadow!.r, 0);
  return {
    measured: closed.length,
    wins: closed.filter((r) => r.shadow!.outcome === 'WIN').length,
    losses: closed.filter((r) => r.shadow!.outcome === 'LOSS').length,
    pending: records.length - closed.length,
    avgR: closed.length ? sumR / closed.length : null,
    sumR,
  };
}
