import type { Balance } from '../types/balance.type';
import type { PaperBalanceStore } from './paper-balance.store';
import { PaperExchangeGateway } from './paper-exchange.gateway';

const BINANCE = { marketDataBaseUrl: 'https://api.binance.com', recvWindow: 5000 } as never;
const TRADING = { paperInitialBalanceAsset: 'USDT', paperInitialBalanceAmount: 10_000 } as never;

class MemoryStore implements PaperBalanceStore {
  constructor(public saved: Balance[] | null = null) {}
  load = jest.fn(async () => this.saved);
  save = jest.fn(async (b: Balance[]) => {
    this.saved = b.map((x) => ({ ...x }));
  });
}

function withFakeMarket(gateway: PaperExchangeGateway, price: number) {
  const client = {
    getCandles: jest.fn().mockResolvedValue([{ close: price }]),
    getSymbolFilters: jest.fn().mockResolvedValue({ baseAsset: 'BTC', quoteAsset: 'USDT' }),
  };
  (gateway as unknown as { marketDataClient: unknown }).marketDataClient = client;
  return gateway;
}

describe('PaperExchangeGateway persistence', () => {
  it('seeds and persists the initial balance on first use', async () => {
    const store = new MemoryStore();
    const gateway = new PaperExchangeGateway(BINANCE, TRADING, store);

    await expect(gateway.getBalance('USDT')).resolves.toEqual({ asset: 'USDT', free: 10_000, locked: 0 });
    expect(store.saved).toEqual([{ asset: 'USDT', free: 10_000, locked: 0 }]);
  });

  it('restores the saved wallet instead of the seed after a restart', async () => {
    const store = new MemoryStore([
      { asset: 'USDT', free: 4_000, locked: 0 },
      { asset: 'BTC', free: 0.1, locked: 0 },
    ]);
    const gateway = new PaperExchangeGateway(BINANCE, TRADING, store);

    await expect(gateway.getBalance('USDT')).resolves.toMatchObject({ free: 4_000 });
    await expect(gateway.getBalance('BTC')).resolves.toMatchObject({ free: 0.1 });
  });

  it('saves the wallet after every fill, so a new instance continues from it', async () => {
    const store = new MemoryStore();
    const first = withFakeMarket(new PaperExchangeGateway(BINANCE, TRADING, store), 60_000);
    await first.placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.05, newClientOrderId: 'x' });

    const second = new PaperExchangeGateway(BINANCE, TRADING, store);
    await expect(second.getBalance('USDT')).resolves.toMatchObject({ free: 10_000 - 0.05 * 60_000 });
    await expect(second.getBalance('BTC')).resolves.toMatchObject({ free: 0.05 });
  });

  it('works in memory without a store', async () => {
    const gateway = new PaperExchangeGateway(BINANCE, TRADING);
    await expect(gateway.getBalance('USDT')).resolves.toMatchObject({ free: 10_000 });
  });
});
