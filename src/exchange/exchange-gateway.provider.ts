import { Logger, Provider } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { binanceConfig, tradingConfig } from '../config/configuration';
import { BinanceExchangeGateway } from './binance/binance-exchange.gateway';
import { EXCHANGE_GATEWAY, ExchangeGateway } from './exchange-gateway.interface';
import { MongoPaperBalanceStore, PaperWallet, type PaperWalletDocument } from './paper/paper-balance.store';
import { PaperExchangeGateway } from './paper/paper-exchange.gateway';

const logger = new Logger('ExchangeModule');

export const exchangeGatewayProvider: Provider = {
  provide: EXCHANGE_GATEWAY,
  inject: [tradingConfig.KEY, binanceConfig.KEY, getModelToken(PaperWallet.name)],
  useFactory: (
    trading: ReturnType<typeof tradingConfig>,
    binance: ReturnType<typeof binanceConfig>,
    paperWalletModel: Model<PaperWalletDocument>,
  ): ExchangeGateway => {
    if (trading.mode === 'LIVE') {
      logger.warn(`TRADING_MODE=LIVE - real orders can be sent to ${binance.baseUrl}`);
      return new BinanceExchangeGateway(binance);
    }
    logger.log(
      `TRADING_MODE=PAPER - no real orders will be sent; market data from ${binance.marketDataBaseUrl}`,
    );
    return new PaperExchangeGateway(binance, trading, new MongoPaperBalanceStore(paperWalletModel));
  },
};
