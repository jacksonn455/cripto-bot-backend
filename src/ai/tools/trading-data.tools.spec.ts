import { IndicatorsService } from '../../indicators/indicators.service';
import { TradingDataTools } from './trading-data.tools';

function makeTools() {
  const reports = {
    summary: jest.fn().mockResolvedValue({ tradeCount: 3, pnlHistogram: [{ bucket: 'x', count: 1 }] }),
    bySide: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  };
  const gateway = { getCandles: jest.fn() };
  const tools = new TradingDataTools(
    {} as never,
    reports as never,
    {} as never,
    {} as never,
    { getAll: () => [] } as never,
    {} as never,
    new IndicatorsService(),
    gateway as never,
    { symbols: ['BTCUSDT'], timeframe: '1h', regimeTimeframe: '4h', emaFast: 20, emaSlow: 50, emaRegime: 200, rsiPeriod: 14, atrPeriod: 14 } as never,
    {} as never,
  );
  return { tools, reports, gateway };
}

describe('TradingDataTools', () => {
  it('exposes only read-only tools', () => {
    const { tools } = makeTools();
    const all = tools.get([
      'get_bot_status', 'get_performance_summary', 'get_performance_breakdown', 'list_recent_trades',
      'list_recent_signals', 'get_strategy_config', 'get_market_snapshot', 'list_backtest_runs',
    ]);
    expect(all.every((t) => t.access === 'read')).toBe(true);
  });

  it('turns strict-schema nulls into "no filter" and drops the histogram', async () => {
    const { tools, reports } = makeTools();
    const [summary] = tools.get(['get_performance_summary']);
    const out = await summary.execute({ mode: 'PAPER', symbol: null, side: 'SHORT', from: null, to: null } as never);
    expect(reports.summary).toHaveBeenCalledWith({ mode: 'PAPER', symbol: undefined, side: 'SHORT', from: undefined, to: undefined });
    expect(out).toEqual({ tradeCount: 3 });
  });

  it('only fetches market data for configured symbols', async () => {
    const { tools, gateway } = makeTools();
    const [snapshot] = tools.get(['get_market_snapshot']);
    const out = await snapshot.execute({ symbol: 'DOGEUSDT' } as never);
    expect(out).toEqual({ error: 'symbol not configured; available: BTCUSDT' });
    expect(gateway.getCandles).not.toHaveBeenCalled();
  });
});
