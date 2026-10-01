import { BinanceRestClient, isTransient } from './binance-rest.client';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { msg: 'x' } } });
const netError = (code: string) => Object.assign(new Error(code), { code });

function clientWith(fake: Record<string, jest.Mock>): BinanceRestClient {
  const client = new BinanceRestClient('', '', 'https://api.binance.com', 5000, 1000);
  (client as unknown as { client: unknown }).client = fake;
  return client;
}

describe('isTransient', () => {
  it('retries network resets and 5xx only', () => {
    expect(isTransient(netError('ECONNRESET'))).toBe(true);
    expect(isTransient(netError('EAI_AGAIN'))).toBe(true);
    expect(isTransient(httpError(502))).toBe(true);
    expect(isTransient(netError('ECONNABORTED'))).toBe(false); // timeout: already waited
    expect(isTransient(httpError(451))).toBe(false); // geo block
    expect(isTransient(httpError(429))).toBe(false);
    expect(isTransient(httpError(400))).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});

describe('BinanceRestClient retry', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries a transient klines failure and returns the data', async () => {
    const klines = jest.fn().mockRejectedValueOnce(netError('ECONNRESET')).mockResolvedValueOnce({ data: [] });
    const promise = clientWith({ klines }).getCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 1 });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
    expect(klines).toHaveBeenCalledTimes(2);
  });

  it('gives up after 2 retries with the clean error', async () => {
    const klines = jest.fn().mockRejectedValue(httpError(503));
    const promise = clientWith({ klines }).getCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 1 });
    const assertion = expect(promise).rejects.toThrow('Binance API error (HTTP 503)');
    await jest.runAllTimersAsync();
    await assertion;
    expect(klines).toHaveBeenCalledTimes(3);
  });

  it('does not retry a geo block (451)', async () => {
    const klines = jest.fn().mockRejectedValue(httpError(451));
    await expect(clientWith({ klines }).getCandles({ symbol: 'BTCUSDT', interval: '1h', limit: 1 })).rejects.toThrow('HTTP 451');
    expect(klines).toHaveBeenCalledTimes(1);
  });

  it('never retries order placement', async () => {
    const newOrder = jest.fn().mockRejectedValue(netError('ECONNRESET'));
    await expect(
      clientWith({ newOrder }).placeOrder({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1, newClientOrderId: 'test-1' }),
    ).rejects.toThrow('ECONNRESET');
    expect(newOrder).toHaveBeenCalledTimes(1);
  });
});
