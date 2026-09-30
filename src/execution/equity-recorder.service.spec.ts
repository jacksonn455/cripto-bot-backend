import { EquityRecorderService } from './equity-recorder.service';

function makeService(opts: { openTrades?: unknown[]; candlesFail?: boolean } = {}) {
  const gateway = {
    getBalance: jest.fn().mockResolvedValue({ asset: 'USDT', free: 9000, locked: 100 }),
    getCandles: opts.candlesFail
      ? jest.fn().mockRejectedValue(new Error('down'))
      : jest.fn().mockResolvedValue([{ close: 110 }]),
  };
  const tradesService = { findAllOpen: jest.fn().mockResolvedValue(opts.openTrades ?? []) };
  const equitySnapshots = { insertMany: jest.fn().mockResolvedValue(undefined) };
  const service = new EquityRecorderService(
    gateway as never,
    tradesService as never,
    equitySnapshots as never,
    { enabled: true, equitySnapshotIntervalMinutes: 5 } as never,
    { mode: 'PAPER' } as never,
  );
  return { service, gateway, tradesService, equitySnapshots };
}

describe('EquityRecorderService', () => {
  it('records cash + open positions marked at the last price', async () => {
    const { service, equitySnapshots, tradesService } = makeService({
      openTrades: [{ symbol: 'BTCUSDT', qty: 2, entryPrice: 100 }],
    });

    await service.record();

    expect(tradesService.findAllOpen).toHaveBeenCalledWith('PAPER');
    expect(equitySnapshots.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({ mode: 'PAPER', balance: 9100, equity: 9100 + 2 * 110, openPositions: 1 }),
    ]);
  });

  it('falls back to the entry price when the last price is unavailable', async () => {
    const { service, equitySnapshots } = makeService({
      openTrades: [{ symbol: 'BTCUSDT', qty: 2, entryPrice: 100 }],
      candlesFail: true,
    });

    await service.record();

    expect(equitySnapshots.insertMany).toHaveBeenCalledWith([expect.objectContaining({ equity: 9100 + 200 })]);
  });

  it('never throws when the balance call fails', async () => {
    const { service, gateway, equitySnapshots } = makeService();
    gateway.getBalance.mockRejectedValueOnce(new Error('timeout'));

    await expect(service.record()).resolves.toBeUndefined();
    expect(equitySnapshots.insertMany).not.toHaveBeenCalled();
  });

  it('values an open short as a liability (-qty * price), since its sale proceeds are already in cash', async () => {
    const { service, equitySnapshots } = makeService({
      openTrades: [{ symbol: 'BTCUSDT', side: 'SHORT', qty: 2, entryPrice: 100 }],
    });

    await service.record();

    // cash 9100 includes the 200 of short proceeds; price rose to 110, so equity = 9100 - 220.
    expect(equitySnapshots.insertMany).toHaveBeenCalledWith([expect.objectContaining({ equity: 9100 - 2 * 110 })]);
  });
});
