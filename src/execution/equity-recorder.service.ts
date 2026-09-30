import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { executionConfig, tradingConfig } from '../config/configuration';
import { EXCHANGE_GATEWAY } from '../exchange/exchange-gateway.interface';
import type { ExchangeGateway } from '../exchange/exchange-gateway.interface';
import { EquitySnapshotsService } from '../reports/equity-snapshots.service';
import { positionValue } from '../trades/position-math.util';
import { TradesService } from '../trades/trades.service';

const QUOTE_ASSET = 'USDT'; // v1: all configured pairs are USDT-quoted (BTCUSDT, ETHUSDT).

/**
 * Periodically writes the PAPER/LIVE equity curve to equity_snapshots (backtests write their own).
 * equity = quote balance (free + locked) + open positions marked at the last 1m close.
 * Observability only: nothing in risk/execution reads these snapshots.
 */
@Injectable()
export class EquityRecorderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EquityRecorderService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(EXCHANGE_GATEWAY) private readonly gateway: ExchangeGateway,
    private readonly tradesService: TradesService,
    private readonly equitySnapshots: EquitySnapshotsService,
    @Inject(executionConfig.KEY) private readonly config: ReturnType<typeof executionConfig>,
    @Inject(tradingConfig.KEY) private readonly trading: ReturnType<typeof tradingConfig>,
  ) {}

  onModuleInit(): void {
    // Same opt-in as the execution loop: with it off, equity can't change, so there's nothing to record.
    if (!this.config.enabled) return;
    this.timer = setInterval(() => void this.record(), this.config.equitySnapshotIntervalMinutes * 60_000);
    void this.record();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async record(): Promise<void> {
    const mode = this.trading.mode;
    try {
      const [quote, openTrades] = await Promise.all([
        this.gateway.getBalance(QUOTE_ASSET),
        this.tradesService.findAllOpen(mode),
      ]);
      const cash = (quote?.free ?? 0) + (quote?.locked ?? 0);

      let positionsValue = 0;
      for (const trade of openTrades) {
        // Long: holds qty (+qty*price). Short: owes qty back (-qty*price); its sale proceeds are in cash.
        const price = (await this.lastPrice(trade.symbol)) ?? trade.entryPrice;
        positionsValue += positionValue(trade.side ?? 'LONG', trade.qty, price);
      }

      await this.equitySnapshots.insertMany([
        {
          mode,
          timestamp: new Date(),
          balance: cash,
          equity: cash + positionsValue,
          openPositions: openTrades.length,
        },
      ]);
    } catch (err) {
      this.logger.warn(`Equity snapshot failed: ${(err as Error).message}`);
    }
  }

  private async lastPrice(symbol: string): Promise<number | undefined> {
    try {
      const [candle] = await this.gateway.getCandles({ symbol, interval: '1m', limit: 1 });
      return candle?.close;
    } catch {
      return undefined;
    }
  }
}
