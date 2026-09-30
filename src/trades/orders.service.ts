import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, OrderDocument } from './schemas/order.schema';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
  ) {}

  async create(order: Partial<Order>): Promise<OrderDocument> {
    return this.orderModel.create(order);
  }

  async findOpenBySymbol(symbol: string): Promise<OrderDocument[]> {
    return this.orderModel.find({
      symbol,
      status: { $in: ['NEW', 'PARTIALLY_FILLED'] },
    });
  }

  async findAllOpen(): Promise<OrderDocument[]> {
    return this.orderModel.find({ status: { $in: ['NEW', 'PARTIALLY_FILLED'] } });
  }

  async updateStatus(
    clientOrderId: string,
    patch: Partial<Pick<Order, 'status' | 'executedQty' | 'filledAt' | 'binanceOrderId'>>,
  ): Promise<void> {
    await this.orderModel.updateOne({ clientOrderId }, { $set: patch });
  }

  async findByTradeId(tradeId: Types.ObjectId | string): Promise<OrderDocument[]> {
    return this.orderModel.find({ tradeId });
  }
}
