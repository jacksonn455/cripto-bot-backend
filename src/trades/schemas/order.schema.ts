import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { OrderSide, OrderStatus, OrderType } from '../../exchange/types/order.type';
import { Trade } from './trade.schema';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ collection: 'orders' })
export class Order {
  @Prop({ type: Types.ObjectId, ref: Trade.name, required: true, index: true })
  tradeId: Types.ObjectId;

  // Denormalized from the trade for cheap reconciliation queries (avoids a join per order).
  @Prop({ required: true, uppercase: true, index: true })
  symbol: string;

  @Prop({ required: true, unique: true })
  clientOrderId: string;

  @Prop()
  binanceOrderId?: string;

  @Prop({
    // A property literally named `type` collides with Mongoose's own schema keyword,
    // so automatic design:type inference fails — must be explicit here.
    type: String,
    required: true,
    enum: ['MARKET', 'LIMIT', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT', 'OCO'],
  })
  type: OrderType;

  @Prop({ type: String, required: true, enum: ['BUY', 'SELL'] })
  side: OrderSide;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  qty: number;

  @Prop({ default: 0 })
  executedQty: number;

  @Prop({
    type: String,
    required: true,
    enum: ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'],
    default: 'NEW',
  })
  status: OrderStatus;

  @Prop({ required: true, default: () => new Date() })
  createdAt: Date;

  @Prop()
  filledAt?: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
