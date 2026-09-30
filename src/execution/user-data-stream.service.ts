import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebsocketStream } from '@binance/connector';
import { executionConfig } from '../config/configuration';
import { BinanceExchangeGateway } from '../exchange/binance/binance-exchange.gateway';
import { EXCHANGE_GATEWAY } from '../exchange/exchange-gateway.interface';
import type { ExchangeGateway } from '../exchange/exchange-gateway.interface';

const KEEPALIVE_INTERVAL_MS = 30 * 60_000; // Binance listenKeys expire after 60 min without a ping.
const BASE_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * Monitors Binance's private User Data Stream for order fill notifications. Only active for
 * TRADING_MODE=LIVE (real orders exist to monitor) — PAPER has no real exchange state.
 * v1 scope: logs order updates as a low-latency heads-up; ReconciliationService remains the
 * source of truth for closing positions, so a missed/duplicate WS message can't cause a
 * double-close. Could not be verified against a live connection in this environment (see
 * README) — the sandbox this was built in cannot reach Binance's network at all.
 */
@Injectable()
export class UserDataStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserDataStreamService.name);
  private listenKey?: string;
  private ws?: WebsocketStream;
  private keepAliveTimer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(EXCHANGE_GATEWAY) private readonly gateway: ExchangeGateway,
    @Inject(executionConfig.KEY) private readonly config: ReturnType<typeof executionConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled || this.gateway.kind !== 'BINANCE') return;
    await this.connect(this.gateway as BinanceExchangeGateway);
  }

  onModuleDestroy(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.ws?.disconnect();
  }

  private async connect(binanceGateway: BinanceExchangeGateway): Promise<void> {
    try {
      this.listenKey = await binanceGateway.createListenKey();
    } catch (err) {
      this.logger.error(`Could not create listenKey for User Data Stream: ${(err as Error).message}`);
      return;
    }

    this.ws = new WebsocketStream({
      wsURL: binanceGateway.wsBaseUrl,
      reconnectDelay: BASE_RECONNECT_DELAY_MS,
      callbacks: {
        open: () => {
          this.logger.log('User Data Stream connected');
        },
        message: (data: string) => this.handleMessage(data),
        close: () => {
          this.logger.warn('User Data Stream disconnected, retrying with backoff');
          if (this.ws) {
            this.ws.reconnectDelay = Math.min(this.ws.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
          }
        },
        error: () => this.logger.error('User Data Stream error'),
      },
    });
    this.ws.subscribe(this.listenKey);

    this.keepAliveTimer = setInterval(() => {
      if (!this.listenKey) return;
      binanceGateway
        .renewListenKey(this.listenKey)
        .catch((err: Error) => this.logger.warn(`Failed to renew listenKey: ${err.message}`));
    }, KEEPALIVE_INTERVAL_MS);
  }

  private handleMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw) as { e?: string; s?: string; c?: string; X?: string };
      if (payload.e === 'executionReport') {
        this.logger.log(`Order update: ${payload.s} ${payload.c} status=${payload.X}`);
      }
    } catch (err) {
      this.logger.warn(`Could not parse User Data Stream message: ${(err as Error).message}`);
    }
  }
}
