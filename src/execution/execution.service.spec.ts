import { Candle } from '../exchange/types/candle.type';
import { ExecutionService } from './execution.service';

function candle(closeTime: number, close: number, high: number, low: number): Candle {
  return {
    symbol: 'BTCUSDT',
    interval: '1h',
    openTime: closeTime - 3_600_000,
    open: close,
    high,
    low,
    close,
    volume: 100,
    closeTime,
    quoteVolume: 100 * close,
    trades: 10,
    isClosed: true,
  };
}

const TRADING_CONFIG = { mode: 'PAPER' as const };
const STRATEGY_CONFIG = {
  timeframe: '1h',
  regimeTimeframe: '1h',
  emaRegime: 10,
  symbols: ['BTCUSDT'],
};
const EXECUTION_CONFIG = { stopLimitOffsetPct: 0.001, enabled: true, pollIntervalSeconds: 60, reconciliationIntervalMinutes: 15 };

function makeDeps(overrides: {
  signal?: unknown;
  decision?: unknown;
  openTrade?: unknown;
  candles?: Candle[];
} = {}) {
  const candles = overrides.candles ?? [candle(1_000, 100, 101, 99)];
  const signal = overrides.signal ?? {
    action: 'ENTER_LONG',
    symbol: 'BTCUSDT',
    strategy: 'TrendRegimeStrategy',
    candleTime: candles[candles.length - 1].closeTime,
    price: 100,
    stopLoss: 90,
    indicators: {},
    reason: 'test',
  };
  const decision = overrides.decision ?? { approved: true, qty: 1 };

  const gateway = {
    kind: 'PAPER' as const,
    getCandles: jest.fn().mockResolvedValue(candles),
    placeOrder: jest.fn().mockResolvedValue({
      symbol: 'BTCUSDT',
      orderId: '1',
      clientOrderId: 'x',
      side: 'BUY',
      type: 'MARKET',
      status: 'FILLED',
      price: 100,
      origQty: 1,
      executedQty: 1,
      createdAt: Date.now(),
    }),
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  };

  const strategy = { name: 'TrendRegimeStrategy', onCandleClosed: jest.fn().mockReturnValue(signal) };
  const strategyRegistry = { get: jest.fn().mockReturnValue(strategy) };
  const riskManager = { evaluate: jest.fn().mockReturnValue(decision) };
  const riskContextBuilder = { build: jest.fn().mockResolvedValue({}) };
  const signalsService = { record: jest.fn().mockResolvedValue(undefined) };
  const tradesService = {
    findOpenPosition: jest.fn().mockResolvedValue(overrides.openTrade ?? null),
    openPosition: jest.fn().mockResolvedValue({ _id: 'trade1', entryPrice: 100 }),
    closePosition: jest.fn().mockResolvedValue(undefined),
  };
  const ordersService = {
    create: jest.fn().mockResolvedValue(undefined),
    findByTradeId: jest.fn().mockResolvedValue([]),
  };
  const reconciliation = { isOk: jest.fn().mockReturnValue(true) };
  const controlService = { checkAutoPauseConditions: jest.fn().mockResolvedValue(undefined) };
  const runtimeStatus = {
    recordCycle: jest.fn(),
    recordError: jest.fn(),
    getLastCycleAgoLabel: jest.fn().mockReturnValue('0s ago'),
  };
  const eventEmitter = { emit: jest.fn() };
  const riskConfigValues = { maxDailyLossPct: 0.03, maxConsecutiveStops: 3 };

  const service = new ExecutionService(
    gateway as never,
    strategyRegistry as never,
    riskManager as never,
    riskContextBuilder as never,
    signalsService as never,
    tradesService as never,
    ordersService as never,
    reconciliation as never,
    controlService as never,
    runtimeStatus as never,
    eventEmitter as never,
    TRADING_CONFIG as never,
    STRATEGY_CONFIG as never,
    EXECUTION_CONFIG as never,
    riskConfigValues as never,
  );

  return { service, gateway, strategy, riskManager, signalsService, tradesService, ordersService };
}

describe('ExecutionService (PAPER mode)', () => {
  it('enters a position when the strategy signals and risk approves', async () => {
    const { service, gateway, tradesService, ordersService, signalsService } = makeDeps();

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'BUY', type: 'MARKET', quantity: 1 }),
    );
    expect(tradesService.openPosition).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'BTCUSDT', stopLoss: 90, status: 'OPEN' }),
    );
    expect(ordersService.create).toHaveBeenCalledTimes(1);
    expect(signalsService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ENTER_LONG' }),
      expect.objectContaining({ approved: true }),
      'PAPER',
    );
  });

  it('does not enter when the risk manager rejects the signal', async () => {
    const { service, gateway, tradesService, signalsService } = makeDeps({
      decision: { approved: false, rejectReason: 'MAX_OPEN_POSITIONS' },
    });

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(tradesService.openPosition).not.toHaveBeenCalled();
    expect(signalsService.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approved: false }),
      'PAPER',
    );
  });

  it('closes an open PAPER position via the conservative intra-candle stop rule', async () => {
    const candles = [candle(2_000, 80, 85, 70)]; // low(70) breaches stopLoss(90)
    const openTrade = {
      _id: 'trade1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice: 100,
      qty: 1,
      stopLoss: 90,
      takeProfit: undefined,
    };
    const { service, gateway, tradesService } = makeDeps({
      candles,
      openTrade,
      signal: { action: 'NONE', symbol: 'BTCUSDT', strategy: 'TrendRegimeStrategy', candleTime: 2_000, price: 80, indicators: {}, reason: 'n/a' },
    });

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(tradesService.closePosition).toHaveBeenCalledWith(
      'trade1',
      expect.objectContaining({ exitPrice: 90, exitReason: 'SL' }),
    );
    expect(gateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL' }));
  });

  it('dedupes repeated cycles for the same closed candle', async () => {
    const { service, gateway } = makeDeps();

    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');
    await service.runCycle('BTCUSDT', 'TrendRegimeStrategy');

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
  });
});
