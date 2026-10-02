import type { EntryCandidate, Signal } from '../strategy/strategy.interface';
import { summarizeFunnel } from './candidate-funnel';
import { InMemoryCandidateLedgerStore } from './candidate-ledger.store';
import { buildCandidateRecords, type CandidateRecordsInput } from './candidate-records';
import { CandidateRecorderService } from './candidate-recorder.service';
import type { CandidateRecord, ShadowOutcome } from './candidate.types';
import { BaselineJudge } from './judge/baseline.judge';
import { validateAssessment } from './judge/candidate-assessment.contract';
import type { CandidateJudge, JudgeInput } from './judge/candidate-judge.interface';
import { NoopJudge } from './judge/noop.judge';
import { syntheticCandles } from './testing/synthetic-candles';

const CLOSE = 1_759_276_799_999;
const gates = (fail?: string): EntryCandidate['gates'] =>
  (['SIDE', 'REGIME', 'RSI', 'INDICATORS'] as const).map((gate) => ({ gate, ok: gate !== fail }));
const cand = (side: 'LONG' | 'SHORT', fail?: string): EntryCandidate => ({
  setupType: 'EMA_CROSS',
  side,
  gates: gates(fail),
  accepted: !fail,
  price: 100,
  stopLoss: side === 'LONG' ? 96 : 104,
});
const signal = (candidates: EntryCandidate[], action: Signal['action'] = 'NONE'): Signal => ({
  action,
  symbol: 'BTCUSDT',
  strategy: 'TrendRegimeStrategy',
  candleTime: CLOSE,
  price: 100,
  indicators: {},
  reason: 'x',
  candidates,
});
const input = (over: Partial<CandidateRecordsInput>): CandidateRecordsInput => ({
  mode: 'PAPER',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  signal: signal([]),
  features: null,
  pause: { paused: false },
  evaluatedAt: new Date(CLOSE),
  ...over,
});
const shadow = (r: number): ShadowOutcome => ({
  status: 'CLOSED', outcome: r > 0 ? 'WIN' : 'LOSS', r, returnPct: r / 50, barsHeld: 5, mfeR: 1, maeR: -1,
  costs: { feesPct: 0, slippagePct: 0, stopSlippagePct: 0, shortBorrowPctPerDay: 0 }, computedAt: new Date(),
});

describe('buildCandidateRecords', () => {
  it('records rejected candidates with the first failing gate, and accepted ones with the risk outcome', () => {
    const [rejected] = buildCandidateRecords(input({ signal: signal([cand('LONG', 'REGIME')]) }));
    expect(rejected).toMatchObject({
      candidateId: `PAPER:BTCUSDT:1h:${CLOSE}:EMA_CROSS:LONG`,
      opportunityId: `BTCUSDT:1h:${CLOSE}:EMA_CROSS:LONG`,
      strategyDecision: 'REJECTED',
      strategyRejectedAt: 'REGIME',
      rejectedAt: 'REGIME',
      finalAction: 'REJECTED',
      stopLoss: 96,
    });
    expect(rejected.risk).toBeUndefined();

    const [entered] = buildCandidateRecords(
      input({ signal: signal([cand('LONG')], 'ENTER_LONG'), risk: { approved: true, qty: 2 }, entry: 'ENTERED' }),
    );
    expect(entered).toMatchObject({ strategyDecision: 'ACCEPTED', rejectedAt: null, finalAction: 'ENTERED', risk: { approved: true, qty: 2 } });
  });

  it('separates the pause from other risk vetoes, and keeps the "as if resumed" counterfactual', () => {
    const accepted = signal([cand('LONG')], 'ENTER_LONG');
    const [paused] = buildCandidateRecords(
      input({
        signal: accepted,
        risk: { approved: false, rejectReason: 'BOT_PAUSED' },
        riskIfResumed: { approved: true, qty: 1 },
        pause: { paused: true, reason: 'CONSECUTIVE_STOPS_LIMIT' },
      }),
    );
    expect(paused).toMatchObject({
      rejectedAt: 'PAUSE', finalAction: 'REJECTED', botPaused: true, pauseReason: 'CONSECUTIVE_STOPS_LIMIT',
      riskIfResumed: { approved: true },
    });
    const [vetoed] = buildCandidateRecords(input({ signal: accepted, risk: { approved: false, rejectReason: 'DAILY_LOSS_LIMIT' } }));
    expect(vetoed).toMatchObject({ rejectedAt: 'RISK', risk: { approved: false, rejectReason: 'DAILY_LOSS_LIMIT' } });
    expect(vetoed.riskIfResumed).toBeUndefined();
    const [failed] = buildCandidateRecords(input({ signal: accepted, risk: { approved: true, qty: 1 }, entry: 'FAILED' }));
    expect(failed).toMatchObject({ rejectedAt: 'EXECUTION', finalAction: 'ENTRY_FAILED' });
  });

  it('no candidates on the signal → no records (quiet candles write nothing)', () => {
    expect(buildCandidateRecords(input({ signal: { ...signal([]), candidates: undefined } }))).toEqual([]);
  });
});

describe('summarizeFunnel', () => {
  it('counts each stage in order, with the shadow outcome of what each stage removed', () => {
    const rows: CandidateRecord[] = [
      ...buildCandidateRecords(input({ signal: signal([cand('SHORT', 'SIDE')]) })).map((r) => ({ ...r, shadow: shadow(2) })),
      ...buildCandidateRecords(input({ signal: signal([cand('LONG', 'REGIME')]) })).map((r) => ({ ...r, shadow: shadow(-1) })),
      ...buildCandidateRecords(input({ signal: signal([cand('LONG', 'RSI')]) })),
      ...buildCandidateRecords(
        input({
          signal: signal([cand('LONG')], 'ENTER_LONG'),
          risk: { approved: false, rejectReason: 'BOT_PAUSED' },
          riskIfResumed: { approved: true, qty: 1 },
          pause: { paused: true, reason: 'DAILY_LOSS_LIMIT' },
        }),
      ).map((r) => ({ ...r, shadow: shadow(3) })),
      ...buildCandidateRecords(input({ signal: signal([cand('LONG')], 'ENTER_LONG'), risk: { approved: false, rejectReason: 'MAX_OPEN_POSITIONS' } })),
      ...buildCandidateRecords(input({ signal: signal([cand('LONG')], 'ENTER_LONG'), risk: { approved: true, qty: 1 }, entry: 'ENTERED' })).map(
        (r) => ({ ...r, shadow: shadow(-1) }),
      ),
    ];
    const f = summarizeFunnel(rows);
    expect(f.total).toBe(6);
    expect(f.bySide).toEqual({ LONG: 5, SHORT: 1 });
    expect(f.strategyAccepted).toBe(3);
    expect(f.entered).toBe(1);
    expect(f.steps.map((s) => [s.step, s.entering, s.rejected, s.remaining])).toEqual([
      ['SIDE', 6, 1, 5],
      ['REGIME', 5, 1, 4],
      ['RSI', 4, 1, 3],
      ['ADX', 3, 0, 3],
      ['INDICATORS', 3, 0, 3],
      ['PAUSE', 3, 1, 2],
      ['RISK', 2, 1, 1],
      ['EXECUTION', 1, 0, 1],
    ]);
    expect(f.steps.find((s) => s.step === 'SIDE')!.rejectedShadow).toMatchObject({ measured: 1, wins: 1, avgR: 2 });
    expect(f.riskRejectReasons).toEqual({ MAX_OPEN_POSITIONS: 1 });
    expect(f.paused).toMatchObject({ candidatesWhileBotPaused: 1, blockedByPause: 1, wouldTradeIfResumed: 1 });
    expect(f.paused.blockedShadow).toMatchObject({ measured: 1, wins: 1, sumR: 3 });
    expect(f.shadow).toMatchObject({ rejectedWinners: 2, rejectedLosers: 1 });
    expect(f.shadow.rejected).toMatchObject({ measured: 3, pending: 2 });
    expect(f.shadow.entered).toMatchObject({ measured: 1, avgR: -1 });
  });
});

const FEATURES = {
  version: 1, close: 100, emaFast: 99, emaSlow: 98, rsi: 60, atr: 2, adx: null, atrToPrice: 0.02, emaSpreadAtr: 0.5,
  closeVsEmaFastAtr: 0.5, return1: 0.01, return24: 0.05, regime: { close: 100, ema: 95, distance: 100 / 95 - 1, state: 'UP' as const },
};
const judgeInput = (accepted: boolean, fail?: string): JudgeInput => ({
  candidateId: 'PAPER:BTCUSDT:1h:1:EMA_CROSS:LONG',
  side: 'LONG',
  setupType: 'EMA_CROSS',
  features: FEATURES,
  deterministic: { gates: gates(fail), strategyAccepted: accepted },
});

describe('judges and the assessment contract', () => {
  it('NoopJudge always approves with no information', async () => {
    for (const accepted of [true, false]) {
      const a = await new NoopJudge().assess(judgeInput(accepted, accepted ? undefined : 'RSI'));
      expect(a).toMatchObject({ verdict: 'APPROVE', setupQuality: 50, warnings: [], keyFactors: [] });
      expect(validateAssessment(a, { candidateId: a.candidateId, features: FEATURES }).valid).toBe(true);
    }
  });

  it('BaselineJudge restates the deterministic rules: verdict = strategy decision, ordinal score, warnings = failed gates', async () => {
    const ok = await new BaselineJudge().assess(judgeInput(true));
    expect(ok).toMatchObject({ verdict: 'APPROVE', setupQuality: 100, warnings: [] });
    const bad = await new BaselineJudge().assess(judgeInput(false, 'REGIME'));
    expect(bad).toMatchObject({ verdict: 'REJECT', setupQuality: 75, warnings: ['COUNTER_REGIME'] });
    expect(bad.keyFactors).toContainEqual({ feature: 'regime.distance', value: FEATURES.regime.distance, effect: 'AGAINST' });
    expect(validateAssessment(bad, { candidateId: bad.candidateId, features: FEATURES }).valid).toBe(true);
  });

  it('rejects made-up numbers, unknown features, other candidates and out-of-contract fields', async () => {
    const base = await new BaselineJudge().assess(judgeInput(true));
    const check = (raw: unknown) => validateAssessment(raw, { candidateId: base.candidateId, features: FEATURES });
    expect(check({ ...base, keyFactors: [{ feature: 'rsi', value: 72, effect: 'SUPPORTS' }] }).errors[0]).toMatch(/does not match/);
    expect(check({ ...base, keyFactors: [{ feature: 'macd', value: 1, effect: 'SUPPORTS' }] }).errors[0]).toMatch(/not an input feature/);
    expect(check({ ...base, candidateId: 'other' }).valid).toBe(false);
    expect(check({ ...base, setupQuality: 0.73 }).valid).toBe(false);
    expect(check({ ...base, verdict: 'LONG' }).valid).toBe(false);
  });
});

describe('CandidateRecorderService', () => {
  const candles = syntheticCandles({ count: 260, seed: 3 });
  const params = { emaFast: 20, emaSlow: 50, emaRegime: 200, rsiPeriod: 14, atrPeriod: 14 };
  const config = (over: object = {}) => ({ ledgerEnabled: true, judgeMode: 'off', judge: 'noop', judgeTimeoutMs: 50, shadowRefreshMinutes: 0, ...over }) as never;
  const recordInput = { ...input({ signal: signal([cand('LONG', 'RSI'), cand('SHORT', 'SIDE')]) }), strategyParams: params, candles };

  it('persists every candidate with features; AI_JUDGE_MODE=off runs no judge', async () => {
    const store = new InMemoryCandidateLedgerStore();
    const judge = { id: 'spy', assess: jest.fn() };
    const out = await new CandidateRecorderService(config(), store, judge).record(recordInput);
    expect(out).toHaveLength(2);
    expect(store.rows.size).toBe(2);
    expect(out[0].features?.rsi).toEqual(expect.any(Number));
    expect(out.every((r) => r.assessment === undefined)).toBe(true);
    expect(judge.assess).not.toHaveBeenCalled();
  });

  it('shadow mode stores the assessment; a failing or slow judge only loses its own assessment', async () => {
    const store = new InMemoryCandidateLedgerStore();
    const shadowOut = await new CandidateRecorderService(config({ judgeMode: 'shadow' }), store, new BaselineJudge()).record(recordInput);
    expect(shadowOut[0].assessment).toMatchObject({ judgeId: 'baseline:v1', judgeMode: 'shadow', valid: true, assessment: { verdict: 'REJECT' } });

    const broken: CandidateJudge = { id: 'broken', assess: () => Promise.reject(new Error('boom')) };
    const slow: CandidateJudge = { id: 'slow', assess: () => new Promise(() => undefined) };
    for (const judge of [broken, slow]) {
      const out = await new CandidateRecorderService(config({ judgeMode: 'shadow' }), new InMemoryCandidateLedgerStore(), judge).record(recordInput);
      expect(out).toHaveLength(2);
      expect(out[0].assessment).toMatchObject({ valid: false, error: expect.any(String) });
    }
  });

  it('CANDIDATE_LEDGER_ENABLED=false writes nothing; a failing store never throws', async () => {
    const store = new InMemoryCandidateLedgerStore();
    expect(await new CandidateRecorderService(config({ ledgerEnabled: false }), store).record(recordInput)).toEqual([]);
    expect(store.rows.size).toBe(0);
    const failing = Object.assign(new InMemoryCandidateLedgerStore(), { upsertMany: () => Promise.reject(new Error('mongo down')) });
    await expect(new CandidateRecorderService(config(), failing).record(recordInput)).resolves.toEqual([]);
  });
});
