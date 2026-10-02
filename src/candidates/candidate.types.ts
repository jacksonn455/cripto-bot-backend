import type { TradeExitReason } from '../trades/schemas/trade.schema';
import type { CandidateGate, SetupType } from '../strategy/strategy.interface';
import type { CandidateFeatures } from './candidate-features';
import type { CandidateAssessment } from './judge/candidate-assessment.contract';
import type { JudgeMode } from './judge/candidate-judge.interface';

/**
 * Where a candidate left the funnel. The strategy gates come first (SIDE → REGIME → RSI → ADX →
 * INDICATORS); an accepted one then meets RiskManager, whose FIRST check is the bot pause — so
 * PAUSE = vetoed with BOT_PAUSED, RISK = any other veto; EXECUTION = approved but the entry failed.
 */
export type CandidateStage = CandidateGate | 'PAUSE' | 'RISK' | 'EXECUTION';
export const STRATEGY_STAGES: readonly CandidateGate[] = ['SIDE', 'REGIME', 'RSI', 'ADX', 'INDICATORS'];

export type CandidateFinalAction = 'ENTERED' | 'REJECTED' | 'ENTRY_FAILED';

export interface CandidateRiskResult {
  approved: boolean;
  rejectReason?: string;
  qty?: number;
}

/**
 * What would have happened had the candidate been traded: a hypothetical entry at the candle close,
 * the strategy's own stop and the same exit rules as the backtest. Never an order of any kind.
 */
export interface ShadowOutcome {
  /** CLOSED = an exit rule fired; OPEN = still running at the end of the data (r is mark-to-market). */
  status: 'CLOSED' | 'OPEN';
  outcome: 'WIN' | 'LOSS' | 'OPEN';
  /** Net of the modeled costs, in units of the initial risk (|entry fill − initial stop|). */
  r: number;
  /** Net return on the entry notional (fraction). */
  returnPct: number;
  exitReason?: TradeExitReason;
  exitTime?: number;
  exitPrice?: number;
  barsHeld: number;
  /** Best / worst excursion while open, in R. */
  mfeR: number;
  maeR: number;
  costs: { feesPct: number; slippagePct: number; stopSlippagePct: number; shortBorrowPctPerDay: number };
  computedAt: Date;
}

export interface StoredAssessment {
  judgeId: string;
  judgeMode: JudgeMode;
  assessedAt: Date;
  latencyMs: number;
  /** Schema + grounding checks passed; an invalid assessment is kept for analysis only. */
  valid: boolean;
  errors: string[];
  assessment?: CandidateAssessment;
  /** The judge threw or timed out. */
  error?: string;
}

/** One row of the candidate ledger: an opportunity, every gate it met, and what became of it. */
export interface CandidateRecord {
  candidateId: string;
  opportunityId: string;
  mode: string;
  /** Backtest only. */
  runId?: string;
  symbol: string;
  timeframe: string;
  regimeTimeframe?: string;
  candleCloseTime: number;
  side: 'LONG' | 'SHORT';
  setupType: SetupType;
  strategy: string;
  price: number;
  stopLoss?: number;

  strategyDecision: 'ACCEPTED' | 'REJECTED';
  gates: Array<{ gate: CandidateGate; ok: boolean }>;
  /** First failing strategy gate (REJECTED only). */
  strategyRejectedAt?: CandidateGate;
  features: CandidateFeatures | null;

  /** Only for strategy-accepted candidates: the real RiskManager decision. */
  risk?: CandidateRiskResult;
  /**
   * Only when vetoed by BOT_PAUSED: RiskManager re-run, read-only, as if someone had resumed at that
   * moment (pause off, consecutive-stop streak restarted, daily PnL unchanged — what POST /bot/resume does).
   */
  riskIfResumed?: Omit<CandidateRiskResult, 'qty'>;
  botPaused: boolean;
  pauseReason?: string;

  rejectedAt: CandidateStage | null;
  finalAction: CandidateFinalAction;
  evaluatedAt: Date;

  assessment?: StoredAssessment;
  shadow?: ShadowOutcome;
}
