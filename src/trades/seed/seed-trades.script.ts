/**
 * Dev-only fake data generator so the (future) dashboard has trades to render.
 * Run with: pnpm run seed
 */
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppModule } from '../../app.module';
import { Trade, TradeMode } from '../schemas/trade.schema';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;
const BASE_PRICE: Record<(typeof SYMBOLS)[number], number> = {
  BTCUSDT: 60000,
  ETHUSDT: 3200,
};
const STRATEGY = 'TrendRegimeStrategy';
const MODES: TradeMode[] = ['PAPER', 'BACKTEST'];
const TRADE_COUNT = 60;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function buildFakeTrade(index: number): Partial<Trade> {
  const symbol = SYMBOLS[index % SYMBOLS.length];
  const base = BASE_PRICE[symbol];
  const mode = MODES[index % MODES.length];
  const daysAgo = randomBetween(0, 30);
  const entryTime = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const entryPrice = base * randomBetween(0.9, 1.1);
  const atr = entryPrice * 0.02;
  const stopLoss = entryPrice - 2 * atr;
  const takeProfit = entryPrice + 3 * atr;
  const qty = randomBetween(0.01, 0.2);
  // Backtest trades are always closed by the end of a run; only PAPER gets open positions.
  const isOpen = mode === 'PAPER' && index % 5 === 0;

  const trade: Partial<Trade> = {
    symbol,
    side: 'LONG',
    strategy: STRATEGY,
    mode,
    runId: mode === 'BACKTEST' ? `seed-${new Date().toISOString().slice(0, 10)}` : undefined,
    entryPrice,
    qty,
    entryTime,
    fees: entryPrice * qty * 0.001,
    stopLoss,
    takeProfit,
    status: isOpen ? 'OPEN' : 'CLOSED',
    isSeed: true,
  };

  if (!isOpen) {
    const won = Math.random() > 0.45;
    const exitPrice = won
      ? randomBetween(entryPrice, takeProfit)
      : randomBetween(stopLoss, entryPrice);
    const exitTime = new Date(entryTime.getTime() + randomBetween(1, 48) * 60 * 60 * 1000);
    const pnl = (exitPrice - entryPrice) * qty - (trade.fees ?? 0) * 2;
    trade.exitPrice = exitPrice;
    trade.exitTime = exitTime;
    trade.pnl = pnl;
    trade.pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    trade.exitReason = won ? 'TP' : 'SL';
    trade.maxFavorableExcursion = Math.max(0, exitPrice - entryPrice) * qty;
    trade.maxAdverseExcursion = Math.min(0, exitPrice - entryPrice) * qty;
  }

  return trade;
}

/** Hosts considered local dev databases. Anything else (e.g. Atlas) is refused. */
const LOCAL_MONGO_HOSTS = new Set(['localhost', '127.0.0.1', 'mongo']);

/** Fake trades must never reach a shared/hosted database (e.g. the Render/Atlas paper bot). */
function assertLocalDatabase(): void {
  const uri = process.env.MONGO_URI ?? 'mongodb://localhost:27017/trade-bot';
  const hosts = uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@]*@/, '').split(/[/?]/)[0];
  const allLocal = hosts.split(',').every((h) => LOCAL_MONGO_HOSTS.has(h.split(':')[0]));
  if (process.env.NODE_ENV === 'production' || uri.startsWith('mongodb+srv://') || !allLocal) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to seed: MONGO_URI points to a non-local database (${hosts}) or NODE_ENV=production.`);
    process.exit(1);
  }
}

async function main() {
  // Checked before booting the app, so a remote database is never even connected to.
  // Real env vars win over .env, same precedence as ConfigModule.
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on the real environment.
  }
  assertLocalDatabase();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const tradeModel = app.get<Model<Trade>>(getModelToken(Trade.name));

  // `pnpm seed -- --reset` removes previously seeded trades first (only those marked isSeed).
  if (process.argv.includes('--reset')) {
    const { deletedCount } = await tradeModel.deleteMany({ isSeed: true });
    // eslint-disable-next-line no-console
    console.log(`Removed ${deletedCount} previously seeded trades.`);
  }

  const fakeTrades = Array.from({ length: TRADE_COUNT }, (_, i) => buildFakeTrade(i));
  await tradeModel.insertMany(fakeTrades);

  // eslint-disable-next-line no-console
  console.log(`Seeded ${fakeTrades.length} fake trades.`);
  await app.close();
}

void main();
