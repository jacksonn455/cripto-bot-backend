import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { appConfig, binanceConfig, controlConfig, executionConfig, fundingConfig, mongoConfig, notificationsConfig, openAiConfig, redisConfig, riskConfig, tradingConfig, trendRegimeConfig } from './configuration';
import { validationSchema } from './validation.schema';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
      load: [
        appConfig,
        mongoConfig,
        tradingConfig,
        binanceConfig,
        trendRegimeConfig,
        riskConfig,
        executionConfig,
        controlConfig,
        notificationsConfig,
        fundingConfig,
        redisConfig,
        openAiConfig,
      ],
      validate: (config: Record<string, unknown>) => {
        const { error, value } = validationSchema.validate(config, {
          abortEarly: false,
          allowUnknown: true,
        });
        if (error) {
          throw new Error(`Config validation error: ${error.message}`);
        }
        return value as Record<string, unknown>;
      },
    }),
  ],
})
export class AppConfigModule {}
