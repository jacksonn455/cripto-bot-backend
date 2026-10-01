import { MarketPollerService } from './market-poller.service';
import { MarketDataError, type CycleOutcome } from './execution.service';

const EVALUATED: CycleOutcome = { status: 'evaluated', candleCloseTime: 1_000, missedCandles: 0 };
const UNCHANGED: CycleOutcome = { status: 'already-evaluated', candleCloseTime: 1_000 };

const EXECUTION_CONFIG = {
  enabled: true,
  pollIntervalSeconds: 60,
  symbolCycleTimeoutSeconds: 30,
  workerHeartbeatTimeoutSeconds: 300,
};
const STRATEGY_CONFIG = { symbols: ['BTCUSDT', 'ETHUSDT'], timeframe: '1h' };

/**
 * The poller is built here exactly as Nest builds it at boot — no HTTP server, no controller, no
 * SSE subscriber, no browser. If the loop runs in these tests, it runs without a frontend.
 */
function makePoller(runCycle: jest.Mock, config: Partial<typeof EXECUTION_CONFIG> = {}) {
  const executionService = { runCycle };
  const runtimeStatus = { recordPoll: jest.fn(), recordError: jest.fn() };
  const heartbeat = {
    instanceId: 'test-instance',
    markLoopStarted: jest.fn(),
    registerStart: jest.fn().mockResolvedValue(undefined),
    beat: jest.fn().mockResolvedValue(undefined),
    checkStall: jest.fn(),
    markStopped: jest.fn().mockResolvedValue(undefined),
  };
  const incidents = { reportFailure: jest.fn(), reportSuccess: jest.fn() };
  const poller = new MarketPollerService(
    executionService as never,
    runtimeStatus as never,
    heartbeat as never,
    { ...EXECUTION_CONFIG, ...config } as never,
    STRATEGY_CONFIG as never,
    incidents as never,
  );
  return { poller, runtimeStatus, heartbeat, incidents };
}

/** Lets the promise chains started by timers settle. */
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('MarketPollerService (Krypto worker loop)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts by itself at boot and evaluates every configured symbol (no frontend involved)', async () => {
    const runCycle = jest.fn().mockResolvedValue(EVALUATED);
    const { poller, heartbeat } = makePoller(runCycle);

    poller.onModuleInit();
    await flush();

    expect(heartbeat.markLoopStarted).toHaveBeenCalled();
    expect(heartbeat.registerStart).toHaveBeenCalled();
    expect(runCycle).toHaveBeenCalledWith('BTCUSDT', 'TrendRegimeStrategy');
    expect(runCycle).toHaveBeenCalledWith('ETHUSDT', 'TrendRegimeStrategy');
    expect(heartbeat.beat).toHaveBeenCalledWith({ evaluated: true, errors: [], missedCandles: 0 });
    poller.onModuleDestroy();
  });

  it('keeps ticking and writing the heartbeat for hours with nobody watching', async () => {
    const runCycle = jest.fn().mockResolvedValue(UNCHANGED);
    const { poller, heartbeat } = makePoller(runCycle);

    poller.onModuleInit();
    await flush();
    // 11 hours of 60s ticks — the overnight window that used to go dark.
    for (let i = 0; i < 11 * 60; i++) {
      await jest.advanceTimersByTimeAsync(60_000);
    }

    expect(heartbeat.beat.mock.calls.length).toBeGreaterThanOrEqual(11 * 60);
    expect(runCycle.mock.calls.length).toBeGreaterThanOrEqual(2 * 11 * 60);
    // The watchdog runs on its own timer alongside the ticks.
    expect(heartbeat.checkStall.mock.calls.length).toBeGreaterThanOrEqual(11 * 60);
    poller.onModuleDestroy();
  });

  it('BTCUSDT failing does not stop ETHUSDT', async () => {
    const runCycle = jest.fn((symbol: string) =>
      symbol === 'BTCUSDT' ? Promise.reject(new Error('Binance 503')) : Promise.resolve(EVALUATED),
    );
    const { poller, heartbeat, runtimeStatus } = makePoller(runCycle);

    await poller.tick();

    expect(runCycle).toHaveBeenCalledWith('ETHUSDT', 'TrendRegimeStrategy');
    expect(runtimeStatus.recordError).toHaveBeenCalledWith(expect.stringContaining('BTCUSDT'));
    expect(heartbeat.beat).toHaveBeenCalledWith({
      evaluated: true,
      errors: [expect.stringContaining('Execution cycle failed for BTCUSDT: Binance 503')],
      missedCandles: 0,
    });
  });

  it('ETHUSDT failing does not affect BTCUSDT', async () => {
    const runCycle = jest.fn((symbol: string) =>
      symbol === 'ETHUSDT' ? Promise.reject(new Error('parse error')) : Promise.resolve(EVALUATED),
    );
    const { poller, heartbeat } = makePoller(runCycle);

    await poller.tick();

    expect(runCycle).toHaveBeenCalledWith('BTCUSDT', 'TrendRegimeStrategy');
    expect(heartbeat.beat).toHaveBeenCalledWith({
      evaluated: true,
      errors: [expect.stringContaining('ETHUSDT')],
      missedCandles: 0,
    });
  });

  it('survives a temporary error and evaluates normally on the next tick', async () => {
    const runCycle = jest
      .fn()
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue(EVALUATED);
    const { poller, heartbeat } = makePoller(runCycle);

    await poller.tick(); // both symbols fail
    await poller.tick(); // both succeed

    expect(heartbeat.beat).toHaveBeenNthCalledWith(1, { evaluated: false, errors: expect.arrayContaining([expect.any(String)]), missedCandles: 0 });
    expect(heartbeat.beat).toHaveBeenNthCalledWith(2, { evaluated: true, errors: [], missedCandles: 0 });
  });

  it('a hanging symbol times out without blocking the next one, and is not run twice concurrently', async () => {
    let settleHung: (v: CycleOutcome) => void = () => undefined;
    const hung = new Promise<CycleOutcome>((resolve) => (settleHung = resolve));
    const runCycle = jest.fn((symbol: string) => (symbol === 'BTCUSDT' ? hung : Promise.resolve(EVALUATED)));
    const { poller, heartbeat } = makePoller(runCycle, { symbolCycleTimeoutSeconds: 30 });

    const tick = poller.tick();
    await jest.advanceTimersByTimeAsync(30_000);
    await tick;

    expect(runCycle).toHaveBeenCalledWith('ETHUSDT', 'TrendRegimeStrategy');
    expect(heartbeat.beat).toHaveBeenLastCalledWith({
      evaluated: true,
      errors: [expect.stringContaining('timed out after 30s')],
      missedCandles: 0,
    });

    // Still hung: the next tick skips BTC instead of starting a second, concurrent cycle.
    await poller.tick();
    expect(runCycle.mock.calls.filter(([s]) => s === 'BTCUSDT')).toHaveLength(1);

    // Once it settles, BTC is evaluated again.
    settleHung(UNCHANGED);
    await flush();
    await poller.tick();
    expect(runCycle.mock.calls.filter(([s]) => s === 'BTCUSDT')).toHaveLength(2);
  });

  it('never runs two ticks at once', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<CycleOutcome>((resolve) => (release = () => resolve(UNCHANGED)));
    const runCycle = jest.fn().mockReturnValueOnce(slow).mockResolvedValue(UNCHANGED);
    const { poller } = makePoller(runCycle, { symbolCycleTimeoutSeconds: 600 });

    const first = poller.tick();
    await poller.tick(); // skipped: first is still running
    expect(runCycle).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(runCycle).toHaveBeenCalledTimes(2);
  });

  it('writes the heartbeat even when the tick itself blows up unexpectedly', async () => {
    const runCycle = jest.fn().mockResolvedValue(EVALUATED);
    const { poller, heartbeat, runtimeStatus } = makePoller(runCycle);
    runtimeStatus.recordPoll.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(poller.tick()).resolves.toBeUndefined();
    expect(heartbeat.beat).toHaveBeenCalledWith({ evaluated: true, errors: ['Tick failed: boom'], missedCandles: 0 });
  });

  it('records a clean stop on SIGTERM and stops ticking', async () => {
    const runCycle = jest.fn().mockResolvedValue(UNCHANGED);
    const { poller, heartbeat } = makePoller(runCycle);
    poller.onModuleInit();
    await flush();
    const calls = runCycle.mock.calls.length;

    await poller.onApplicationShutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    expect(heartbeat.markStopped).toHaveBeenCalledWith('SIGTERM');
    expect(runCycle.mock.calls.length).toBe(calls);
  });

  it('does nothing when EXECUTION_ENABLED=false', async () => {
    const runCycle = jest.fn();
    const { poller, heartbeat } = makePoller(runCycle, { enabled: false });

    poller.onModuleInit();
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(runCycle).not.toHaveBeenCalled();
    expect(heartbeat.registerStart).not.toHaveBeenCalled();
  });
});

describe('MarketPollerService -> incidents', () => {
  it('a Binance failure is a MARKET_DATA incident for that symbol; the other symbol reports success', async () => {
    const runCycle = jest.fn((symbol: string) =>
      symbol === 'BTCUSDT' ? Promise.reject(new MarketDataError('timeout of 15000ms exceeded')) : Promise.resolve(EVALUATED),
    );
    const { poller, incidents } = makePoller(runCycle);

    await poller.tick();

    expect(incidents.reportFailure).toHaveBeenCalledTimes(1);
    expect(incidents.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'MARKET_DATA:BTCUSDT', type: 'MARKET_DATA_ERROR', symbol: 'BTCUSDT' }),
    );
    expect(incidents.reportSuccess).toHaveBeenCalledWith('MARKET_DATA:ETHUSDT');
    expect(incidents.reportSuccess).toHaveBeenCalledWith('EVALUATION:ETHUSDT');
  });

  it('a non-market-data failure is an EVALUATION incident (market data marked healthy)', async () => {
    const runCycle = jest.fn().mockRejectedValueOnce(new Error('Mongo write failed')).mockResolvedValue(EVALUATED);
    const { poller, incidents } = makePoller(runCycle);

    await poller.tick();

    expect(incidents.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ key: 'EVALUATION:BTCUSDT', type: 'EVALUATION_ERROR' }));
    expect(incidents.reportSuccess).toHaveBeenCalledWith('MARKET_DATA:BTCUSDT');
  });

  it('reports the candles missed while down in the heartbeat summary', async () => {
    const runCycle = jest.fn().mockResolvedValue({ status: 'evaluated', candleCloseTime: 1, missedCandles: 3 });
    const { poller, heartbeat } = makePoller(runCycle);

    await poller.tick();

    expect(heartbeat.beat).toHaveBeenCalledWith({ evaluated: true, errors: [], missedCandles: 6 });
  });
});
