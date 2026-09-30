import { Inject, Injectable } from '@nestjs/common';
import { tradingConfig } from './config/configuration';

@Injectable()
export class AppService {
  constructor(
    @Inject(tradingConfig.KEY)
    private readonly trading: ReturnType<typeof tradingConfig>,
  ) {}

  getInfo() {
    return {
      name: 'trade-bot-backend',
      tradingMode: this.trading.mode,
      docs: '/docs',
    };
  }
}
