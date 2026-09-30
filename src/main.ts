import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // SWAGGER_ENABLED=false hides /docs on a public host (it isn't behind the API key guard).
  if (process.env.SWAGGER_ENABLED !== 'false') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Trade Bot API')
      .setDescription(
        'Backend for a personal/educational Binance trade bot. Paper mode by default — see README for risk disclaimer.',
      )
      .setVersion('0.1.0')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  const port = process.env.PORT ?? 8000;
  // 0.0.0.0 (default) = reachable from the network/Docker; 127.0.0.1 = only this machine.
  await app.listen(port, process.env.HOST || '0.0.0.0');
}
void bootstrap();
