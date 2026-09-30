import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from './schemas/order.schema';
import { Trade, TradeSchema } from './schemas/trade.schema';
import { OrdersService } from './orders.service';
import { TradesController } from './trades.controller';
import { TradesService } from './trades.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Trade.name, schema: TradeSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
  ],
  controllers: [TradesController],
  providers: [TradesService, OrdersService],
  exports: [TradesService, OrdersService],
})
export class TradesModule {}
