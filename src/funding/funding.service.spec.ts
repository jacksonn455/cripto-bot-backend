import { computeStats, FundingService } from './funding.service';

const SCAN_AT = new Date('2026-09-29T12:00:00.000Z');
const NEXT = new Date('2026-09-29T16:00:00.000Z');
const row = (symbol: string, rate: number) => ({ symbol, rate, nextFundingTime: NEXT, timestamp: SCAN_AT });
const SCAN = [row('BTCUSDT', 0.0001), row('ETHUSDT', -0.00005), row('DOGEUSDT', 0.0003), row('XUSDT', -0.001), row('ZEROUSDT', 0)];

function makeDeps(overrides: { premiumIndex?: unknown; premiumIndexError?: Error; scan?: unknown[] | null } = {}) {
  let latest: Date | null = overrides.scan === null ? null : SCAN_AT;
  const fundingRateModel = {
    insertMany: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(() => ({ sort: () => ({ lean: () => Promise.resolve(latest ? { timestamp: latest } : null) }) })),
    find: jest.fn(() => ({ lean: () => Promise.resolve(overrides.scan ?? SCAN) })),
  };
  const config = { enabled: true, baseUrl: 'https://fapi.binance.com' };
  const service = new FundingService(fundingRateModel as never, config, { symbols: ['BTCUSDT', 'ETHUSDT'] } as never);

  // Swap in a fake client so scan() never hits the network.
  (service as unknown as { client: unknown }).client = {
    getPremiumIndex: overrides.premiumIndexError
      ? jest.fn().mockRejectedValue(overrides.premiumIndexError)
      : jest.fn().mockResolvedValue(
          overrides.premiumIndex ?? [
            { symbol: 'BTCUSDT', lastFundingRate: 0.0001, nextFundingTime: 1_700_000_000_000, time: 1_699_999_000_000 },
          ],
        ),
  };

  return { service, fundingRateModel, setLatest: (d: Date) => (latest = d) };
}

describe('FundingService scan', () => {
  it('scans and records one funding_rates document per symbol', async () => {
    const { service, fundingRateModel } = makeDeps();
    await service.scan();
    expect(fundingRateModel.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({ symbol: 'BTCUSDT', exchange: 'BINANCE', rate: 0.0001, nextFundingTime: new Date(1_700_000_000_000) }),
    ]);
  });

  it('never throws when the Futures API call fails (read-only, must not crash the app)', async () => {
    const { service, fundingRateModel } = makeDeps({ premiumIndexError: new Error('network down') });
    await expect(service.scan()).resolves.toBeUndefined();
    expect(fundingRateModel.insertMany).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    const { fundingRateModel } = makeDeps();
    const disabled = new FundingService(fundingRateModel as never, { enabled: false, baseUrl: 'x' });
    await disabled.scan();
    expect(fundingRateModel.insertMany).not.toHaveBeenCalled();
  });
});

describe('FundingService.getPage', () => {
  it('pages the latest scan ordered by annualized rate, with totals', async () => {
    const { service } = makeDeps();
    const page1 = await service.getPage({ page: 1, limit: 2 });
    const page3 = await service.getPage({ page: 3, limit: 2 });

    expect(page1.items.map((r) => r.symbol)).toEqual(['DOGEUSDT', 'BTCUSDT']);
    expect(page1.items[0].annualizedRatePct).toBeCloseTo(32.85);
    expect(page1).toMatchObject({ total: 5, page: 1, limit: 2, scannedAt: SCAN_AT });
    expect(page3.items.map((r) => r.symbol)).toEqual(['XUSDT']);
  });

  it('searches (case-insensitive) and orders asc / by magnitude', async () => {
    const { service } = makeDeps();
    expect((await service.getPage({ page: 1, limit: 10, search: 'usd', order: 'asc' })).items[0].symbol).toBe('XUSDT');
    expect((await service.getPage({ page: 1, limit: 10, order: 'abs' })).items.map((r) => r.symbol).slice(0, 2)).toEqual(['XUSDT', 'DOGEUSDT']);
    const doge = await service.getPage({ page: 1, limit: 10, search: 'doge' });
    expect(doge.total).toBe(1);
    // Stats describe the whole scan, not the search result.
    expect(doge.stats?.count).toBe(5);
  });

  it('reports whole-scan stats and the bot symbols', async () => {
    const { service } = makeDeps();
    const page = await service.getPage({ page: 1, limit: 1 });
    expect(page.stats).toMatchObject({ count: 5, positive: 2, negative: 2, zero: 1, extremeCount: 1, baselineRate: 0.0001 });
    expect(page.watch.map((w) => w.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('reads a scan from Mongo once and again only when a newer scan exists', async () => {
    const { service, fundingRateModel, setLatest } = makeDeps();
    await service.getPage({ page: 1, limit: 5 });
    await service.getPage({ page: 2, limit: 5 });
    expect(fundingRateModel.find).toHaveBeenCalledTimes(1);
    setLatest(new Date('2026-09-29T13:00:00.000Z'));
    await service.getPage({ page: 1, limit: 5 });
    expect(fundingRateModel.find).toHaveBeenCalledTimes(2);
  });

  it('returns an empty page before the first scan', async () => {
    const { service, fundingRateModel } = makeDeps({ scan: null });
    await expect(service.getPage({ page: 1, limit: 5 })).resolves.toMatchObject({ items: [], total: 0, scannedAt: null, stats: null });
    expect(fundingRateModel.find).not.toHaveBeenCalled();
  });
});

describe('computeStats', () => {
  it('computes median and average of the annualized rates', () => {
    const stats = computeStats(
      [0.0001, 0.0002, 0.0003, 0.0004].map((r) => ({ ...row('S', r), annualizedRatePct: r * 1095 * 100 })),
    );
    expect(stats.medianAnnualizedPct).toBeCloseTo(27.375);
    expect(stats.averageAnnualizedPct).toBeCloseTo(27.375);
  });
});
