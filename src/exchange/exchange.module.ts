import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { exchangeGatewayProvider } from './exchange-gateway.provider';
import { ExchangeController } from './exchange.controller';
import { PaperWallet, PaperWalletSchema } from './paper/paper-balance.store';

@Module({
  imports: [MongooseModule.forFeature([{ name: PaperWallet.name, schema: PaperWalletSchema }])],
  controllers: [ExchangeController],
  providers: [exchangeGatewayProvider],
  exports: [exchangeGatewayProvider],
})
export class ExchangeModule {}
