import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { mongoConfig } from '../config/configuration';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [mongoConfig.KEY],
      useFactory: (config: ReturnType<typeof mongoConfig>) => ({
        uri: config.uri,
      }),
    }),
  ],
})
export class DatabaseModule {}
