import { Logger, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { mongoConfig } from '../config/configuration';

const RETRY_DELAY_MS = 10_000;
const logger = new Logger('MongoDB');

/** Driver errors can echo the connection string — never let credentials reach the logs. */
function safeError(err: unknown): string {
  const { name, message } = err as Error;
  return `${name}: ${String(message).replace(/\/\/[^@\s/]*@/g, '//***@')}`;
}

/**
 * Connects in the background and keeps retrying: Mongoose never retries a failed *initial*
 * connection by itself. Queries issued meanwhile are buffered and fail after bufferTimeoutMS.
 */
async function connectWithRetry(connection: Connection, uri: string): Promise<void> {
  let closed = false;
  connection.once('close', () => (closed = true));

  for (let attempt = 1; !closed; attempt++) {
    logger.log(`MongoDB connection attempt started (#${attempt})`);
    try {
      await (attempt === 1 ? connection.asPromise() : connection.openUri(uri));
      logger.log('MongoDB connection established');
      return;
    } catch (err) {
      logger.error(`MongoDB connection failed, retrying in ${RETRY_DELAY_MS / 1000}s - ${safeError(err)}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS).unref());
    }
  }
}

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [mongoConfig.KEY],
      useFactory: (config: ReturnType<typeof mongoConfig>) => ({
        uri: config.uri,
        // Don't block bootstrap on Mongo: the HTTP port (and /health) opens even while the
        // database is unreachable, instead of the process exiting after the connect retries.
        lazyConnection: true,
        connectionFactory: (connection: Connection) => {
          // An 'error' listener also marks the initial connection promise as handled (no crash).
          connection.on('error', (err) => logger.error(`MongoDB connection error - ${safeError(err)}`));
          void connectWithRetry(connection, config.uri);
          return connection;
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
