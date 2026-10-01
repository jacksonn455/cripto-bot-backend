import { Logger } from '@nestjs/common';
import type { DailyReportData } from '../report-notices';
import { DailyReportService, localDayAndHour } from './daily-report.service';

const TZ = 'America/Sao_Paulo'; // UTC-3, no DST

const DATA: DailyReportData = {
  mode: 'PAPER',
  from: new Date('2026-09-30T11:00:00.000Z'),
  to: new Date('2026-10-01T11:00:00.000Z'),
  closedTrades: [],
  totalFees: 0,
  openPositions: [],
  equityNow: null,
  equityStart: null,
  evaluations: 24,
  signalsApproved: 0,
  signalsVetoed: 0,
  activeIncidents: [],
  paused: false,
  workerState: 'ONLINE',
  lastEvaluationAt: null,
};

function make(opts: { claimed?: Set<string>; collectFails?: boolean } = {}) {
  const claimed = opts.claimed ?? new Set<string>();
  const runModel = {
    create: jest.fn(async ({ _id }: { _id: string }) => {
      if (claimed.has(_id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      claimed.add(_id);
    }),
    deleteOne: jest.fn(async ({ _id }: { _id: string }) => {
      claimed.delete(_id);
    }),
  };
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const service = new DailyReportService(
    { dispatch } as never,
    {} as never,
    {} as never,
    {} as never,
    runModel as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dailyReportEnabled: true, dailyReportHour: 8, timeZone: TZ } as never,
    { mode: 'PAPER' } as never,
  );
  const collect = jest.spyOn(service, 'collect');
  if (opts.collectFails) collect.mockRejectedValue(new Error('mongo down'));
  else collect.mockResolvedValue(DATA);
  return { service, dispatch, runModel, claimed, collect };
}

describe('localDayAndHour', () => {
  it('uses the configured zone, not UTC', () => {
    expect(localDayAndHour(new Date('2026-10-01T02:30:00Z'), TZ)).toEqual({ day: '2026-09-30', hour: 23 });
    expect(localDayAndHour(new Date('2026-10-01T11:00:00Z'), TZ)).toEqual({ day: '2026-10-01', hour: 8 });
  });
});

describe('DailyReportService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('waits for the configured local hour', async () => {
    const { service, dispatch } = make();
    expect(await service.tick(new Date('2026-10-01T10:59:00Z'))).toBe(false); // 07:59 local
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('sends once per local day, also catching up later that day', async () => {
    const { service, dispatch, collect } = make();
    expect(await service.tick(new Date('2026-10-01T14:30:00Z'))).toBe(true); // 11:30 local: catch-up
    expect(await service.tick(new Date('2026-10-01T14:31:00Z'))).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ kind: 'report', report: { headline: 'Resumo diário' } });
    expect(collect).toHaveBeenCalledTimes(1);

    expect(await service.tick(new Date('2026-10-02T11:00:00Z'))).toBe(true); // next day 08:00
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('does not resend a day another run already claimed (restart)', async () => {
    const { service, dispatch } = make({ claimed: new Set(['2026-10-01']) });
    expect(await service.tick(new Date('2026-10-01T12:00:00Z'))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('releases the claim when collecting fails, so the next tick retries', async () => {
    const { service, claimed, dispatch } = make({ collectFails: true });
    expect(await service.tick(new Date('2026-10-01T12:00:00Z'))).toBe(false);
    expect(claimed.has('2026-10-01')).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
