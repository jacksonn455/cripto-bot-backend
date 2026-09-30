import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { BacktestService } from '../../backtest/backtest.service';
import { riskConfig, trendRegimeConfig } from '../../config/configuration';
import { ControlService } from '../../control/control.service';
import { EXCHANGE_GATEWAY } from '../../exchange/exchange-gateway.interface';
import type { ExchangeGateway } from '../../exchange/exchange-gateway.interface';
import { IndicatorsService } from '../../indicators/indicators.service';
import { ReportsService } from '../../reports/reports.service';
import { GetSignalsQueryDto } from '../../risk/dto/get-signals-query.dto';
import { SignalsService } from '../../risk/signals.service';
import { StrategyRegistryService } from '../../strategy/strategy-registry.service';
import { GetTradesQueryDto } from '../../trades/dto/get-trades-query.dto';
import { TradesService } from '../../trades/trades.service';
import { AiToolSpec, defineTool, orUndefined } from './ai-tool';

const MODE = z.enum(['BACKTEST', 'PAPER', 'LIVE']).nullable().describe('Modo; null = todos');
const SIDE = z.enum(['LONG', 'SHORT']).nullable().describe('Lado; null = ambos');
const LIMIT = z.number().int().min(1).max(50).nullable().describe('Quantidade máxima de itens; null = 20');

export type ToolName =
  | 'get_bot_status'
  | 'get_performance_summary'
  | 'get_performance_breakdown'
  | 'list_recent_trades'
  | 'list_recent_signals'
  | 'get_strategy_config'
  | 'get_market_snapshot'
  | 'list_backtest_runs';

/**
 * Read-only views of the bot for the agents. Each tool only calls query methods of existing
 * services (the same ones behind the GET endpoints); none of them can place orders, change the
 * bot state or write to the database. Outputs are trimmed to what an analysis needs.
 */
@Injectable()
export class TradingDataTools {
  private readonly tools: Record<ToolName, AiToolSpec>;

  constructor(
    private readonly control: ControlService,
    private readonly reports: ReportsService,
    private readonly trades: TradesService,
    private readonly signals: SignalsService,
    private readonly strategies: StrategyRegistryService,
    private readonly backtests: BacktestService,
    private readonly indicators: IndicatorsService,
    @Inject(EXCHANGE_GATEWAY) private readonly gateway: ExchangeGateway,
    @Inject(trendRegimeConfig.KEY) private readonly strategyConfig: ReturnType<typeof trendRegimeConfig>,
    @Inject(riskConfig.KEY) private readonly risk: ReturnType<typeof riskConfig>,
  ) {
    this.tools = {
      get_bot_status: this.botStatus(),
      get_performance_summary: this.performanceSummary(),
      get_performance_breakdown: this.performanceBreakdown(),
      list_recent_trades: this.recentTrades(),
      list_recent_signals: this.recentSignals(),
      get_strategy_config: this.strategyConfigTool(),
      get_market_snapshot: this.marketSnapshot(),
      list_backtest_runs: this.backtestRuns(),
    };
  }

  get(names: readonly ToolName[]): AiToolSpec[] {
    return names.map((n) => this.tools[n]);
  }

  private botStatus() {
    return defineTool({
      name: 'get_bot_status',
      description: 'Estado atual do bot: modo, pausado, trades abertos, equity, último sinal por símbolo, último erro.',
      access: 'read',
      parameters: z.object({}),
      execute: async () => {
        const s = await this.control.getStatus();
        return {
          mode: s.mode,
          paused: s.paused,
          pauseReason: s.pauseReason ?? null,
          executionEnabled: s.executionEnabled,
          openTrades: s.openTrades,
          freeQuoteBalance: s.equity,
          lastReconciliationOk: s.lastReconciliationOk,
          lastCycleAt: s.lastCycleAt,
          lastSignalBySymbol: s.lastSignalBySymbol,
          lastError: s.lastError,
        };
      },
    });
  }

  private performanceSummary() {
    return defineTool({
      name: 'get_performance_summary',
      description:
        'Métricas sobre trades FECHADOS: PnL, win/loss rate, profit factor, expectancy, drawdown, Sharpe/Sortino, ' +
        'taxas, contagem e métricas por lado (LONG/SHORT), motivos de saída.',
      access: 'read',
      parameters: z.object({
        mode: MODE,
        symbol: z.string().nullable(),
        side: SIDE,
        from: z.string().nullable().describe('Data ISO inicial (entryTime); null = sem limite'),
        to: z.string().nullable().describe('Data ISO final (entryTime); null = sem limite'),
      }),
      execute: async (p) => {
        const summary = await this.reports.summary({
          mode: orUndefined(p.mode),
          symbol: orUndefined(p.symbol),
          side: orUndefined(p.side),
          from: orUndefined(p.from),
          to: orUndefined(p.to),
        });
        const { pnlHistogram: _histogram, ...rest } = summary;
        return rest;
      },
    });
  }

  private performanceBreakdown() {
    return defineTool({
      name: 'get_performance_breakdown',
      description: 'PnL, win rate e profit factor agrupados por lado (LONG/SHORT), símbolo ou estratégia.',
      access: 'read',
      parameters: z.object({ by: z.enum(['side', 'symbol', 'strategy']), mode: MODE }),
      execute: async (p) => {
        const filter = { mode: orUndefined(p.mode) };
        if (p.by === 'side') return this.reports.bySide(filter, 1, 20);
        if (p.by === 'symbol') return this.reports.bySymbol(filter, 1, 20);
        return this.reports.byStrategy(filter, 1, 20);
      },
    });
  }

  private recentTrades() {
    return defineTool({
      name: 'list_recent_trades',
      description: 'Trades mais recentes (por data de entrada, mais novo primeiro), com motivo de entrada e de saída.',
      access: 'read',
      parameters: z.object({
        mode: MODE,
        symbol: z.string().nullable(),
        side: SIDE,
        status: z.enum(['OPEN', 'CLOSED']).nullable(),
        limit: LIMIT,
      }),
      execute: async (p) => {
        const query = Object.assign(new GetTradesQueryDto(), {
          mode: orUndefined(p.mode),
          symbol: orUndefined(p.symbol),
          side: orUndefined(p.side),
          status: orUndefined(p.status),
          isSeed: false,
          limit: p.limit ?? 20,
        });
        const page = await this.trades.findAll(query);
        return {
          total: page.total,
          items: page.items.map((t) => ({
            symbol: t.symbol,
            side: t.side,
            mode: t.mode,
            status: t.status,
            timeframe: t.timeframe ?? null,
            entryTime: t.entryTime,
            exitTime: t.exitTime ?? null,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice ?? null,
            qty: t.qty,
            stopLoss: t.stopLoss,
            pnl: t.pnl ?? null,
            pnlPct: t.pnlPct ?? null,
            fees: t.fees,
            exitReason: t.exitReason ?? null,
            entryReason: t.entryReason ?? null,
            maxAdverseExcursion: t.maxAdverseExcursion ?? null,
            maxFavorableExcursion: t.maxFavorableExcursion ?? null,
          })),
        };
      },
    });
  }

  private recentSignals() {
    return defineTool({
      name: 'list_recent_signals',
      description: 'Sinais de entrada avaliados pelo risco (aprovados ou vetados, com rejectReason e indicadores).',
      access: 'read',
      parameters: z.object({
        mode: MODE,
        symbol: z.string().nullable(),
        approved: z.boolean().nullable().describe('true = aprovados, false = vetados, null = todos'),
        limit: LIMIT,
      }),
      execute: async (p) => {
        const query = Object.assign(new GetSignalsQueryDto(), {
          mode: orUndefined(p.mode),
          symbol: orUndefined(p.symbol),
          approved: orUndefined(p.approved),
          limit: p.limit ?? 20,
        });
        const page = await this.signals.list(query);
        return {
          total: page.total,
          items: page.items.map((s) => ({
            symbol: s.symbol,
            signal: s.signal,
            approved: s.approved,
            rejectReason: s.rejectReason ?? null,
            reason: s.reason ?? null,
            price: s.price ?? null,
            candleTime: s.candleTime,
            mode: s.mode,
            indicators: s.indicators,
          })),
        };
      },
    });
  }

  private strategyConfigTool() {
    return defineTool({
      name: 'get_strategy_config',
      description: 'Regras e parâmetros atuais da estratégia e os limites do gerenciamento de risco.',
      access: 'read',
      parameters: z.object({}),
      execute: async () => ({
        symbols: this.strategyConfig.symbols,
        timeframe: this.strategyConfig.timeframe,
        regimeTimeframe: this.strategyConfig.regimeTimeframe,
        strategies: this.strategies.getAll().map((s) => ({
          name: s.name,
          params: s.getParams?.() ?? {},
          paramSpec: s.paramSpec ?? [],
        })),
        rules:
          'LONG: close > EMA(emaRegime) no timeframe de regime, EMA rápida cruza acima da lenta, RSI em [rsiMin,rsiMax]; ' +
          'stop = entrada - atrStopMultiplier*ATR; saída no cruzamento contrário ou chandelier (máxima - N*ATR). ' +
          'SHORT (só com allowShort=1): espelho exato, RSI em [100-rsiMax, 100-rsiMin], stop acima, chandelier na mínima.',
        risk: this.risk,
      }),
    });
  }

  private marketSnapshot() {
    return defineTool({
      name: 'get_market_snapshot',
      description:
        'Indicadores atuais (candles fechados) de um símbolo configurado: preço, EMAs, RSI, ATR e ATR% no ' +
        'timeframe da estratégia, e close vs EMA de regime no timeframe de regime.',
      access: 'read',
      parameters: z.object({ symbol: z.string().describe('Um dos símbolos configurados, ex.: BTCUSDT') }),
      execute: async (p) => {
        const symbol = p.symbol.toUpperCase();
        if (!this.strategyConfig.symbols.includes(symbol)) {
          return { error: `symbol not configured; available: ${this.strategyConfig.symbols.join(', ')}` };
        }
        const c = this.strategyConfig;
        const limit = c.emaRegime + 20;
        const [candles, regimeCandles] = await Promise.all([
          this.closedCandles(symbol, c.timeframe, limit),
          this.closedCandles(symbol, c.regimeTimeframe, limit),
        ]);
        const closes = candles.map((k) => k.close);
        const last = candles[candles.length - 1];
        if (!last) return { error: 'no market data available' };
        const pick = (series: Array<number | undefined>) => series[series.length - 1] ?? null;
        const atr = pick(this.indicators.atr(c.atrPeriod, candles.map((k) => k.high), candles.map((k) => k.low), closes));
        const regimeCloses = regimeCandles.map((k) => k.close);
        const emaRegime = pick(this.indicators.ema(c.emaRegime, regimeCloses));
        const lastRegimeClose = regimeCloses[regimeCloses.length - 1] ?? null;
        const back = closes[Math.max(0, closes.length - 25)];
        return {
          symbol,
          timeframe: c.timeframe,
          lastCandleClose: new Date(last.closeTime).toISOString(),
          close: last.close,
          changePctLast24Candles: back ? ((last.close - back) / back) * 100 : null,
          emaFast: pick(this.indicators.ema(c.emaFast, closes)),
          emaSlow: pick(this.indicators.ema(c.emaSlow, closes)),
          rsi: pick(this.indicators.rsi(c.rsiPeriod, closes)),
          atr,
          atrPctOfPrice: atr !== null ? (atr / last.close) * 100 : null,
          regime: {
            timeframe: c.regimeTimeframe,
            close: lastRegimeClose,
            emaRegime,
            state:
              emaRegime === null || lastRegimeClose === null
                ? 'unknown'
                : lastRegimeClose > emaRegime
                  ? 'up'
                  : lastRegimeClose < emaRegime
                    ? 'down'
                    : 'flat',
          },
        };
      },
    });
  }

  private backtestRuns() {
    return defineTool({
      name: 'list_backtest_runs',
      description: 'Execuções de backtest mais recentes com métricas, custos, benchmark buy-and-hold e nº de variações testadas.',
      access: 'read',
      parameters: z.object({ limit: z.number().int().min(1).max(10).nullable() }),
      execute: async (p) => {
        const page = await this.backtests.listRuns({ page: 1, limit: p.limit ?? 5 });
        return page.items.map((r) => ({
          runId: r.runId,
          strategy: r.strategy,
          symbols: r.symbols,
          timeframe: r.timeframe,
          from: r.from,
          to: r.to,
          params: r.params,
          summary: r.summary,
          walkForwardWindows: r.walkForwardWindows?.length ?? 0,
          benchmark: r.benchmark ?? null,
          costs: r.costs ?? null,
          exposurePct: r.exposurePct ?? null,
          paramVariationsTestedForStrategy: r.paramVariationsTestedForStrategy,
        }));
      },
    });
  }

  private async closedCandles(symbol: string, interval: string, limit: number) {
    const candles = await this.gateway.getCandles({ symbol, interval, limit: limit + 2 });
    return candles.filter((k) => k.isClosed);
  }
}
