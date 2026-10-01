#!/usr/bin/env node
// Posts the auto-deploy result to the Discord webhook from .env (run with node --env-file=.env).
// Usage: node --env-file=.env scripts/deploy-notify.js <success|failure> <title> <description> [duration] [log file]
// Same switches as the app's operational alerts: DISCORD_ENABLED=true and DISCORD_ALERTS_ENABLED!=false.
// Plain Node (no build step), so it still works when the deploy failed to build. Never prints the URL.
'use strict';

const fs = require('node:fs');
const os = require('node:os');

const [status, title, description = '', duration = '', logFile = ''] = process.argv.slice(2);
const env = process.env;
const url = env.DISCORD_WEBHOOK_URL ?? '';

if (env.DISCORD_ENABLED !== 'true' || !url || env.DISCORD_ALERTS_ENABLED === 'false') process.exit(0);

// Log lines can carry connection strings or tokens (a failed boot prints its error).
const REDACT = [
  [/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\S+/gi, '[webhook]'],
  [/(mongodb(?:\+srv)?|rediss?|amqps?|postgres(?:ql)?):\/\/[^\s@/]+@/gi, '$1://[credentials]@'],
  [/\b(api[_-]?key|secret|token|password|passwd)(["'\s:=]+)[^\s"',]+/gi, '$1$2[redacted]'],
];
const redact = (text) => REDACT.reduce((t, [re, to]) => t.replace(re, to), text);
const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function logTail(file, lines = 20) {
  try {
    const tail = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines).join('\n');
    return truncate(redact(tail).replace(/```/g, "'''"), 990);
  } catch {
    return '';
  }
}

const ok = status === 'success';
const fields = [
  ['Ambiente', (env.KRYPTO_ENVIRONMENT ?? env.NODE_ENV ?? 'production').toUpperCase()],
  ['Host', os.hostname()],
  ...(duration ? [['Duração', duration]] : []),
];
if (!ok && logFile) {
  const tail = logTail(logFile);
  if (tail) fields.push(['Últimas linhas do log', '```\n' + tail + '\n```', false]);
  fields.push(['Log completo', logFile.split('/').slice(-2).join('/')]);
}

const payload = {
  username: truncate(env.DISCORD_USERNAME || 'Trade Bot', 80),
  allowed_mentions: { parse: [] },
  embeds: [
    {
      title: truncate(`${ok ? '🚀' : '💥'} KRYPTO — ${title}`, 256),
      description: truncate(redact(description) || (ok ? 'Nova versão no ar.' : 'O processo em execução não foi alterado.'), 4000),
      color: ok ? 0x2ecc71 : 0xe74c3c,
      fields: fields.map(([name, value, inline = true]) => ({ name, value: truncate(value || '—', 1024), inline })),
      footer: { text: ok ? 'auto-deploy' : 'auto-deploy · próximo commit tenta de novo (ou rode scripts/deploy.sh)' },
      timestamp: new Date().toISOString(),
    },
  ],
};

fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(10_000),
})
  .then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  })
  .catch((err) => {
    console.error(`deploy-notify: Discord delivery failed: ${redact(String(err.message ?? err))}`);
    process.exit(1);
  });
