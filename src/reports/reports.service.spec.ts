import { isValidTimeZone } from './dto/by-hour-query.dto';
import { ReportsService } from './reports.service';

/** Minimal Mongoose model stub: records every find/aggregate call and returns canned data. */
function makeService(opts: { aggregateResult?: unknown[] } = {}) {
  const finds: Record<string, unknown>[] = [];
  const pipelines: unknown[][] = [];
  const tradeModel = {
    find: jest.fn((match: Record<string, unknown>) => {
      finds.push(match);
      return { lean: () => Promise.resolve([]) };
    }),
    aggregate: jest.fn((pipeline: unknown[]) => {
      pipelines.push(pipeline);
      return Promise.resolve(opts.aggregateResult ?? []);
    }),
  };
  // Cache always misses.
  const cache = { getOrSet: jest.fn((_k: string, _t: number, factory: () => Promise<unknown>) => factory()) };
  const service = new ReportsService(tradeModel as never, cache as never, { reportsTtlSeconds: 30 } as never);
  return { service, finds, pipelines };
}

describe('ReportsService.compareModes', () => {
  it('returns the three modes; period applies to PAPER/LIVE and runId only to BACKTEST', async () => {
    const { service, finds } = makeService();

    const result = await service.compareModes({
      strategy: 'TrendRegimeStrategy',
      from: '2026-09-01T00:00:00.000Z',
      runId: 'bt_1',
      dateField: 'exitTime',
    });

    expect(result.map((r) => r.mode)).toEqual(['BACKTEST', 'PAPER', 'LIVE']);
    expect(result[0].runId).toBe('bt_1');
    expect(result[0].summary.tradeCount).toBe(0);

    const [backtest, paper, live] = finds;
    expect(backtest).toEqual({ status: 'CLOSED', mode: 'BACKTEST', strategy: 'TrendRegimeStrategy', runId: 'bt_1' });
    expect(paper).toEqual({
      status: 'CLOSED',
      mode: 'PAPER',
      strategy: 'TrendRegimeStrategy',
      exitTime: { $gte: new Date('2026-09-01T00:00:00.000Z') },
    });
    expect(live).toMatchObject({ mode: 'LIVE' });
    expect(live).not.toHaveProperty('runId');
  });
});

describe('ReportsService.byHour', () => {
  it('buckets in the requested time zone and sorts keys numerically', async () => {
    const rows = ['10', '2', '0'].map((key) => ({ key, tradeCount: 1, totalPnl: 1, winRate: 1, profitFactor: 0 }));
    const { service, pipelines } = makeService({ aggregateResult: rows });

    const result = await service.byHour({ mode: 'PAPER' }, 'America/Sao_Paulo');

    expect(result.timezone).toBe('America/Sao_Paulo');
    expect(result.byHourOfDay.map((r) => r.key)).toEqual(['0', '2', '10']);
    expect(JSON.stringify(pipelines[0])).toContain('"$hour":{"date":"$exitTime","timezone":"America/Sao_Paulo"}');
    expect(JSON.stringify(pipelines[1])).toContain('"$dayOfWeek":{"date":"$exitTime","timezone":"America/Sao_Paulo"}');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects garbage', () => {
    expect(isValidTimeZone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
