import { notificationsConfig, tradingConfig } from '../config/configuration';
import { formatClock, formatSpan } from '../incidents/incident-format.util';
import { DiscordNotificationProvider } from '../notifications/discord/discord-notification.provider';
import type { OpsNotice } from '../notifications/notification.types';

/**
 * Sends a sample INCIDENT followed by its RECOVERED through the real Discord provider and
 * webhook — to check formatting and delivery without waiting for a real outage.
 *
 *   pnpm alert:test            (reads DISCORD_* from the environment / .env)
 *
 * A local CLI on purpose: there is no HTTP endpoint that can trigger alerts. Refuses to run with
 * NODE_ENV=production so it can't be fired from a production shell by accident.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to send test alerts with NODE_ENV=production');
  }
  const config = notificationsConfig();
  const discord = new DiscordNotificationProvider(config);
  if (!discord.isEnabled()) throw new Error('Discord is disabled: set DISCORD_ENABLED=true and DISCORD_WEBHOOK_URL');
  if (!config.discordAlertsEnabled) throw new Error('DISCORD_ALERTS_ENABLED=false: operational alerts are off');

  const env = `${config.environment} · ${tradingConfig().mode} · TESTE`;
  const startedAt = new Date(Date.now() - 86_000);
  const now = new Date();
  const clock = (d: Date) => formatClock(d, config.timeZone);
  const incident: OpsNotice = {
    phase: 'incident',
    headline: 'INCIDENT (TESTE)',
    summary: 'Binance API (market data) · BTCUSDT: timeout of 15000ms exceeded — mensagem de teste, nada está fora do ar.',
    severity: 'warning',
    fields: [
      ['Componente', 'Binance API (market data)'],
      ['Status', 'DEGRADED'],
      ['Problema', 'timeout of 15000ms exceeded'],
      ['Símbolo', 'BTCUSDT'],
      ['Tentativas', '3'],
      ['Início', clock(startedAt)],
      ['Ambiente', env],
    ],
    incidentKey: 'TEST:MARKET_DATA:BTCUSDT',
    at: startedAt.toISOString(),
  };
  const recovery: OpsNotice = {
    phase: 'recovery',
    headline: 'RECOVERED (TESTE)',
    summary: 'Binance API (market data) · BTCUSDT voltou a operar normalmente — mensagem de teste.',
    severity: 'info',
    fields: [
      ['Componente', 'Binance API (market data)'],
      ['Status', 'OPERATIONAL'],
      ['Início', clock(startedAt)],
      ['Recuperado', clock(now)],
      ['Duração', formatSpan(now.getTime() - startedAt.getTime())],
      ['Ambiente', env],
    ],
    incidentKey: 'TEST:MARKET_DATA:BTCUSDT',
    at: now.toISOString(),
  };
  for (const notice of [incident, recovery]) {
    const result = await discord.send({ kind: 'ops', notice });
    console.log(`${notice.headline}: ${result.delivered ? 'delivered' : `NOT delivered (${result.error})`}`);
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
