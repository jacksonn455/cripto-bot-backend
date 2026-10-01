import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { WorkerHeartbeatService } from './control/worker-heartbeat.service';
import { sanitizeForAlert } from './incidents/incident-format.util';
import { IncidentService } from './incidents/incident.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const logger = app.get(Logger);

  // SIGTERM (deploy, platform stop) runs onApplicationShutdown: the worker records a clean stop
  // in its persisted heartbeat, so an outage can later be told apart from a planned restart.
  app.enableShutdownHooks();
  const incidents = app.get(IncidentService);
  const heartbeat = app.get(WorkerHeartbeatService);
  // A stray rejected promise is logged and reported, but doesn't exit: the rejection belongs to one
  // async task (all loop/cycle state is per-call or persisted), and Node's default exit would cost
  // every symbol its next evaluation. Reported once per message per cooldown.
  process.on('unhandledRejection', (reason) => {
    logger.error(`[KRYPTO_WORKER] unhandled_rejection error="${reason instanceof Error ? reason.stack : String(reason)}"`, 'Process');
    const message = reason instanceof Error ? reason.message : String(reason);
    incidents.reportEvent({
      key: `UNHANDLED_REJECTION:${message.slice(0, 80)}`,
      type: 'UNHANDLED_ERROR',
      component: 'Processo do backend/worker',
      error: reason,
    });
  });
  // After an uncaught exception the process state is unknown: log, record the crash (so the next
  // run reports RESTARTED), try to notify — all time-bounded — then exit so the host restarts it.
  process.on('uncaughtException', (err) => {
    logger.error(`[KRYPTO_WORKER] uncaught_exception error="${err.stack ?? err.message}" - exiting`, 'Process');
    void Promise.allSettled([heartbeat.markCrashed(sanitizeForAlert(err)), incidents.reportCrash(err)]).finally(() =>
      process.exit(1),
    );
    setTimeout(() => process.exit(1), 5_000).unref();
  });

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

  // Render injects PORT; 8000 is the local fallback.
  const port = Number(process.env.PORT) || 8000;
  // 0.0.0.0 (default) = reachable from the network/Docker; 127.0.0.1 = only this machine.
  const host = process.env.HOST || '0.0.0.0';
  await app.listen(port, host);
  logger.log(`Server listening on ${host}:${port}`, 'Bootstrap');
}
// A failed bootstrap (port in use, bad config) is fatal: exit so the host restarts or reports it,
// instead of the unhandledRejection handler above keeping a half-started process alive.
bootstrap().catch((err: Error) => {
  console.error(`[KRYPTO_WORKER] bootstrap_failed error="${err.stack ?? err.message}"`);
  process.exit(1);
});
