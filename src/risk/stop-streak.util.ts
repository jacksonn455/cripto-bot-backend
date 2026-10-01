/**
 * The single rule for the consecutive-stop streak behind CONSECUTIVE_STOPS_LIMIT: a stop-loss exit
 * extends it, any other exit (signal, trailing, manual, kill switch…) ends it. Paper and live count
 * it from the stored trades (countStopStreak); the backtest applies it as each trade closes
 * (nextStopStreak). What differs is only who lifts the resulting pause: a manual resume in
 * paper/live, the next UTC day in a backtest (nobody resumes a simulation).
 */
export function nextStopStreak(streak: number, exitReason: string | undefined): number {
  return exitReason === 'SL' ? streak + 1 : 0;
}

/**
 * Current streak from closed trades, oldest first. Callers pass only the trades closed after the
 * last manual resume, so resuming starts the count over.
 */
export function countStopStreak(closedOldestFirst: ReadonlyArray<{ exitReason?: string }>): number {
  return closedOldestFirst.reduce((streak, t) => nextStopStreak(streak, t.exitReason), 0);
}
