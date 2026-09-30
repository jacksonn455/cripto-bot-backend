import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GetCandlesQueryDto } from './dto/get-candles-query.dto';
import { EXCHANGE_GATEWAY } from './exchange-gateway.interface';
import type { ExchangeGateway } from './exchange-gateway.interface';

@ApiTags('exchange')
@Controller('exchange')
export class ExchangeController {
  constructor(
    @Inject(EXCHANGE_GATEWAY) private readonly exchange: ExchangeGateway,
  ) {}

  @Get('balance')
  @ApiOperation({ summary: 'Current balances (real on Binance testnet, simulated in PAPER mode)' })
  @ApiOkResponse({ description: 'List of balances per asset' })
  getBalances() {
    return this.exchange.getBalances();
  }

  @Get('candles')
  @ApiOperation({ summary: 'Closed candles for a symbol/interval' })
  @ApiOkResponse({ description: 'List of candles, oldest first' })
  getCandles(@Query() query: GetCandlesQueryDto) {
    return this.exchange.getCandles(query);
  }
}
