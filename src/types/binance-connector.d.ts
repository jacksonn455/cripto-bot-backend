// @binance/connector ships no type declarations; this is the minimal surface we use,
// isolated here so the rest of the codebase stays fully typed.
declare module '@binance/connector' {
  export interface BinanceResponse<T = unknown> {
    data: T;
    status: number;
    headers: Record<string, string>;
  }

  export interface SpotOptions {
    baseURL?: string;
    recvWindow?: number;
    timeout?: number;
  }

  export class Spot {
    constructor(apiKey?: string, apiSecret?: string, options?: SpotOptions);

    ping(): Promise<BinanceResponse<Record<string, never>>>;
    time(): Promise<BinanceResponse<{ serverTime: number }>>;
    exchangeInfo(
      options?: Record<string, unknown>,
    ): Promise<BinanceResponse<unknown>>;
    klines(
      symbol: string,
      interval: string,
      options?: Record<string, unknown>,
    ): Promise<BinanceResponse<unknown[][]>>;

    account(options?: Record<string, unknown>): Promise<BinanceResponse<unknown>>;
    newOrder(
      symbol: string,
      side: string,
      type: string,
      options?: Record<string, unknown>,
    ): Promise<BinanceResponse<unknown>>;
    cancelOrder(
      symbol: string,
      options?: Record<string, unknown>,
    ): Promise<BinanceResponse<unknown>>;
    openOrders(options?: Record<string, unknown>): Promise<BinanceResponse<unknown[]>>;
    getOrder(symbol: string, options?: Record<string, unknown>): Promise<BinanceResponse<unknown>>;

    createListenKey(
      options?: Record<string, unknown>,
    ): Promise<BinanceResponse<{ listenKey: string }>>;
    renewListenKey(
      listenKey: string,
      options?: Record<string, unknown>,
    ): Promise<BinanceResponse<Record<string, never>>>;
    closeListenKey(
      listenKey: string,
      options?: Record<string, unknown>,
    ): Promise<BinanceResponse<Record<string, never>>>;
  }

  export interface WebsocketStreamCallbacks {
    open?: (client: WebsocketStream) => void;
    close?: () => void;
    message?: (data: string) => void;
    error?: (err?: unknown) => void;
    ping?: () => void;
    pong?: () => void;
  }

  export interface WebsocketStreamOptions {
    wsURL?: string;
    callbacks?: WebsocketStreamCallbacks;
    /** Base reconnect delay in ms; mutate this from the `close` callback for backoff. */
    reconnectDelay?: number;
    combinedStreams?: boolean;
  }

  export class WebsocketStream {
    reconnectDelay: number;
    constructor(options?: WebsocketStreamOptions);
    subscribe(stream: string | string[]): void;
    unsubscribe(stream: string | string[]): void;
    disconnect(): void;
    isConnected(): boolean;
  }
}
