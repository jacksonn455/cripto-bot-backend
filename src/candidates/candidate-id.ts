import type { SetupType } from '../strategy/strategy.interface';

export interface CandidateIdentity {
  symbol: string;
  timeframe: string;
  /** Close time (epoch ms) of the candle the setup triggered on. */
  candleCloseTime: number;
  setupType: SetupType;
  side: 'LONG' | 'SHORT';
}

/**
 * The opportunity itself, independent of who looked at it: the same candle + setup + side has the
 * same opportunityId in PAPER, LIVE, every backtest run and any offline shadow analysis — the key
 * to join them. Deterministic, never random.
 */
export function opportunityId(c: CandidateIdentity): string {
  return `${c.symbol.toUpperCase()}:${c.timeframe}:${c.candleCloseTime}:${c.setupType}:${c.side}`;
}

/** One mode's view of an opportunity: `mode:symbol:timeframe:candleClose:setupType:side`. */
export function candidateId(mode: string, c: CandidateIdentity): string {
  return `${mode}:${opportunityId(c)}`;
}
