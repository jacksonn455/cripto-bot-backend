import { RiskContextBuilderService } from './risk-context-builder.service';

/** Minimal chainable stand-in for Model.find(...).sort().limit().lean(). */
function query<T>(rows: T[]) {
  const chain = { sort: () => chain, limit: () => chain, lean: () => Promise.resolve(rows) };
  return chain;
}

function makeBuilder(openTrades: unknown[]) {
  const tradeModel = {
    find: jest.fn((filter: { status: string }) => query(filter.status === 'OPEN' ? openTrades : [])),
  };
  const controlService = { isPaused: jest.fn().mockResolvedValue(false) };
  return new RiskContextBuilderService(tradeModel as never, controlService as never);
}

function gateway(opts: { free: number; supportsShortSelling?: boolean }) {
  return {
    supportsShortSelling: opts.supportsShortSelling,
    getBalance: jest.fn().mockResolvedValue({ asset: 'USDT', free: opts.free, locked: 0 }),
    getSymbolFilters: jest.fn().mockRejectedValue(new Error('offline')),
  };
}

describe('RiskContextBuilderService', () => {
  it('reports whether the venue can short', async () => {
    const builder = makeBuilder([]);
    const spot = await builder.build(gateway({ free: 1000, supportsShortSelling: false }) as never, 'BTCUSDT', 'LIVE', 'USDT', true);
    const paper = await builder.build(gateway({ free: 1000, supportsShortSelling: true }) as never, 'BTCUSDT', 'PAPER', 'USDT', true);
    expect(spot.shortSellingSupported).toBe(false);
    expect(paper.shortSellingSupported).toBe(true);
  });

  it('uses the free balance as-is with only longs open (unchanged behavior)', async () => {
    const builder = makeBuilder([{ symbol: 'BTCUSDT', side: 'LONG', qty: 1, entryPrice: 1000 }]);
    const ctx = await builder.build(gateway({ free: 9000 }) as never, 'ETHUSDT', 'PAPER', 'USDT', true);
    expect(ctx.accountEquity).toBe(9000);
    expect(ctx.totalExposure).toBe(1000);
  });

  it('does not let short sale proceeds inflate the buying power', async () => {
    // Started with 10,000; shorted 1,000 of BTC: free cash is 11,000. A long of the same size would
    // have left 9,000 to size the next trade, and so must the short.
    const builder = makeBuilder([{ symbol: 'BTCUSDT', side: 'SHORT', qty: 1, entryPrice: 1000 }]);
    const ctx = await builder.build(gateway({ free: 11_000, supportsShortSelling: true }) as never, 'ETHUSDT', 'PAPER', 'USDT', true);
    expect(ctx.accountEquity).toBe(9000);
    expect(ctx.currentExposureByAsset).toEqual({ BTCUSDT: 1000 });
  });
});
