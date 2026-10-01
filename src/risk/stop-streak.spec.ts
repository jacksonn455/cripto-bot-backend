import { ControlService } from '../control/control.service';
import { RiskContextBuilderService } from './risk-context-builder.service';
import { RiskManagerService } from './risk-manager.service';
import { countStopStreak, nextStopStreak } from './stop-streak.util';
import type { Signal } from '../strategy/strategy.interface';

/**
 * The consecutive-stops lock end to end for paper/live: trades and bot_state live in "Mongo"
 * (in-memory stand-ins shared across service instances, like a real DB across process restarts),
 * ControlService persists the resume, RiskContextBuilder counts the streak, RiskManager vetoes.
 */

type StoredTrade = { mode: string; status: 'OPEN' | 'CLOSED'; exitReason?: string; exitTime?: Date; symbol: string; side: string; qty: number; entryPrice: number };

function makeDb() {
  const trades: StoredTrade[] = [];
  const state: Record<string, unknown> = {};
  return { trades, state };
}

/** Minimal Model.find(filter).sort().limit().lean() honoring the filters the builder uses. */
function tradeModel(db: ReturnType<typeof makeDb>) {
  return {
    find: (filter: { mode: string; status: string; exitTime?: { $gt?: Date; $gte?: Date } }) => {
      let rows = db.trades.filter((t) => t.mode === filter.mode && t.status === filter.status);
      if (filter.exitTime?.$gt) rows = rows.filter((t) => t.exitTime! > filter.exitTime!.$gt!);
      if (filter.exitTime?.$gte) rows = rows.filter((t) => t.exitTime! >= filter.exitTime!.$gte!);
      const chain = {
        sort: () => {
          rows = [...rows].sort((a, b) => b.exitTime!.getTime() - a.exitTime!.getTime());
          return chain;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return chain;
        },
        lean: () => Promise.resolve(rows),
      };
      return chain;
    },
  };
}

function stateModel(db: ReturnType<typeof makeDb>) {
  return {
    findOne: () => Promise.resolve(Object.keys(db.state).length ? { ...db.state } : null),
    create: (doc: Record<string, unknown>) => Promise.resolve(Object.assign(db.state, doc) && { ...db.state }),
    updateOne: (_f: unknown, update: { $set: Record<string, unknown>; $unset?: Record<string, unknown> }) => {
      Object.assign(db.state, update.$set);
      for (const key of Object.keys(update.$unset ?? {})) delete db.state[key];
      return Promise.resolve({});
    },
  };
}

/** A "process": fresh service instances over the same persisted db. */
function boot(db: ReturnType<typeof makeDb>) {
  const control = new ControlService(
    stateModel(db) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { mode: 'PAPER' } as never,
    { emit: jest.fn() } as never,
    {} as never,
  );
  const builder = new RiskContextBuilderService(tradeModel(db) as never, control);
  const gateway = {
    supportsShortSelling: true,
    getBalance: jest.fn().mockResolvedValue({ asset: 'USDT', free: 10_000, locked: 0 }),
    getSymbolFilters: jest.fn().mockRejectedValue(new Error('offline')),
  };
  const ctx = () => builder.build(gateway as never, 'BTCUSDT', 'PAPER', 'USDT', true);
  return { control, ctx };
}

const risk = new RiskManagerService({
  riskPerTradePct: 0.01,
  maxOpenPositions: 3,
  maxExposurePerAssetPct: 1,
  maxTotalExposurePct: 1,
  maxDailyLossPct: 1,
  maxConsecutiveStops: 3,
  minRiskRewardRatio: 0,
  minVolume24h: 0,
  maxSpreadPct: 100,
});
const entry: Signal = { action: 'ENTER_LONG', symbol: 'BTCUSDT', strategy: 'T', candleTime: 0, price: 100, stopLoss: 95, indicators: {}, reason: '' };
const exit: Signal = { ...entry, action: 'EXIT', stopLoss: undefined };

let clock = Date.UTC(2026, 0, 1);
function close(db: ReturnType<typeof makeDb>, exitReason: string) {
  clock += 3_600_000;
  db.trades.push({ mode: 'PAPER', status: 'CLOSED', exitReason, exitTime: new Date(clock), symbol: 'BTCUSDT', side: 'LONG', qty: 1, entryPrice: 100 });
}

describe('stop-streak rule (shared by backtest and paper/live)', () => {
  it('a stop extends the streak, any other exit ends it', () => {
    expect(nextStopStreak(2, 'SL')).toBe(3);
    expect(nextStopStreak(2, 'SIGNAL')).toBe(0);
    expect(nextStopStreak(2, 'KILL_SWITCH')).toBe(0);
    expect(countStopStreak([{ exitReason: 'SL' }, { exitReason: 'SIGNAL' }, { exitReason: 'SL' }, { exitReason: 'SL' }])).toBe(2);
  });
});

describe('consecutive-stops lock in paper/live', () => {
  beforeEach(() => {
    clock = Date.UTC(2026, 0, 1);
  });

  it('3 stops in a row block new entries', async () => {
    const db = makeDb();
    ['SL', 'SL', 'SL'].forEach((r) => close(db, r));
    const ctx = await boot(db).ctx();
    expect(ctx.consecutiveStopLosses).toBe(3);
    expect(risk.evaluate(entry, ctx)).toEqual({ approved: false, rejectReason: 'CONSECUTIVE_STOPS_LIMIT' });
  });

  it('2 stops + a normal exit reset the streak to zero', async () => {
    const db = makeDb();
    ['SL', 'SL', 'SIGNAL'].forEach((r) => close(db, r));
    const ctx = await boot(db).ctx();
    expect(ctx.consecutiveStopLosses).toBe(0);
    expect(risk.evaluate(entry, ctx).approved).toBe(true);
  });

  it('3 stops → blocked → manual resume → entries allowed again, and new stops count from there', async () => {
    const db = makeDb();
    ['SL', 'SL', 'SL'].forEach((r) => close(db, r));
    const proc = boot(db);
    expect(risk.evaluate(entry, await proc.ctx()).approved).toBe(false);

    jest.useFakeTimers({ now: clock + 60_000 });
    await proc.control.resume();
    jest.useRealTimers();
    expect(db.state.stopStreakResetAt).toBeInstanceOf(Date);
    expect(risk.evaluate(entry, await proc.ctx())).toEqual({ approved: true, qty: 20 });

    close(db, 'SL');
    expect((await proc.ctx()).consecutiveStopLosses).toBe(1);
  });

  it('a process restart neither clears the lock nor undoes a resume (both live in bot_state)', async () => {
    const db = makeDb();
    ['SL', 'SL', 'SL'].forEach((r) => close(db, r));
    // Restart while locked: still locked (a Render redeploy must not switch the limit off).
    expect((await boot(db).ctx()).consecutiveStopLosses).toBe(3);

    jest.useFakeTimers({ now: clock + 60_000 });
    await boot(db).control.resume();
    jest.useRealTimers();
    // Restart after the resume: still resumed.
    const afterRestart = await boot(db).ctx();
    expect(afterRestart.consecutiveStopLosses).toBe(0);
    expect(afterRestart.isPaused).toBe(false);
  });

  it('never touches a position already open: exits pass while entries are locked', async () => {
    const db = makeDb();
    ['SL', 'SL', 'SL'].forEach((r) => close(db, r));
    db.trades.push({ mode: 'PAPER', status: 'OPEN', symbol: 'BTCUSDT', side: 'LONG', qty: 1, entryPrice: 100 });
    const ctx = await boot(db).ctx();
    expect(ctx.openPositionsCount).toBe(1);
    expect(risk.evaluate(exit, ctx)).toEqual({ approved: true });
    expect(risk.evaluate(entry, ctx).rejectReason).toBe('CONSECUTIVE_STOPS_LIMIT');
  });
});
