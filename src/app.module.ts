import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './config/app-config.module';
import { CacheModule } from './cache/cache.module';
import { ControlModule } from './control/control.module';
import { DatabaseModule } from './database/database.module';
import { ExchangeModule } from './exchange/exchange.module';
import { BacktestModule } from './backtest/backtest.module';
import { EventsModule } from './events/events.module';
import { ExecutionModule } from './execution/execution.module';
import { FundingModule } from './funding/funding.module';
import { HealthModule } from './health/health.module';
import { MarketDataModule } from './market-data/market-data.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { RiskModule } from './risk/risk.module';
import { StrategyModule } from './strategy/strategy.module';
import { TradesModule } from './trades/trades.module';

@Module({
  imports: [
    AppConfigModule,
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        redact: ['req.headers.authorization', 'req.headers["x-mbx-apikey"]'],
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    CacheModule,
    DatabaseModule,
    ExchangeModule,
    TradesModule,
    StrategyModule,
    RiskModule,
    MarketDataModule,
    ReportsModule,
    BacktestModule,
    ExecutionModule,
    ControlModule,
    NotificationsModule,
    EventsModule,
    FundingModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
