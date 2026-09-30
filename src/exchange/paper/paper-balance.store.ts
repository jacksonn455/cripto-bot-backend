import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Model } from 'mongoose';
import type { Balance } from '../types/balance.type';

/** Singleton document with the simulated PAPER wallet. Delete it to reset the paper balance. */
@Schema({ collection: 'paper_balances' })
export class PaperWallet {
  @Prop({ required: true })
  _id: string;

  @Prop({ type: [Object], required: true })
  balances: Balance[];

  @Prop({ required: true })
  updatedAt: Date;
}

export type PaperWalletDocument = HydratedDocument<PaperWallet>;
export const PaperWalletSchema = SchemaFactory.createForClass(PaperWallet);

export interface PaperBalanceStore {
  load(): Promise<Balance[] | null>;
  save(balances: Balance[]): Promise<void>;
}

const WALLET_ID = 'paper';

export class MongoPaperBalanceStore implements PaperBalanceStore {
  constructor(private readonly model: Model<PaperWalletDocument>) {}

  async load(): Promise<Balance[] | null> {
    const doc = await this.model.findById(WALLET_ID).lean();
    return doc?.balances ?? null;
  }

  async save(balances: Balance[]): Promise<void> {
    await this.model.updateOne(
      { _id: WALLET_ID },
      { $set: { balances, updatedAt: new Date() } },
      { upsert: true },
    );
  }
}
