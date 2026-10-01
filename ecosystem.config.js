// PM2 process file for the Oracle VM (see docs/DEPLOY_ORACLE.md). No secrets here: the API loads
// them from ./.env (ConfigModule) and the watchdog via --env-file.
//
// krypto-backend MUST stay a single fork-mode process: it runs MarketPollerService, and a second
// instance (cluster mode, instances > 1) would evaluate and trade every candle twice.
module.exports = {
  apps: [
    {
      name: 'krypto-backend',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      // The VM has 1 GB RAM: cap the V8 heap and restart before the OOM killer steps in.
      node_args: '--max-old-space-size=640',
      max_memory_restart: '700M',
      autorestart: true,
      // A run shorter than min_uptime counts as a crash; after max_restarts crashes in a row PM2
      // gives up (the heartbeat watchdog then reports WORKER OFFLINE on Discord).
      min_uptime: '30s',
      max_restarts: 10,
      // Backoff between crash restarts: 2 s, growing up to ~15 s; reset once a run is stable.
      exp_backoff_restart_delay: 2000,
      // Time for the graceful shutdown (stop the poller, record "stopped" in the heartbeat, close
      // Mongo/Redis) before SIGKILL. The PM2 default (1.6 s) can cut the heartbeat write.
      kill_timeout: 10000,
      watch: false,
      out_file: './logs/krypto-backend.out.log',
      error_file: './logs/krypto-backend.err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env_production: {
        NODE_ENV: 'production',
      },
    },
    {
      // External heartbeat watchdog: a one-shot run every 5 min that reads the persisted heartbeat
      // and alerts WORKER OFFLINE on Discord. Read-only, never runs the strategy. It can't see a
      // dead VM: an external uptime monitor on /health covers that (docs/DEPLOY_ORACLE.md), and
      // optionally .github/workflows/heartbeat-watchdog.yml (manual-only until enabled).
      name: 'krypto-watchdog',
      script: 'dist/watchdog/heartbeat-watchdog.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      node_args: '--env-file=.env',
      autorestart: false,
      cron_restart: '*/5 * * * *',
      max_memory_restart: '150M',
      watch: false,
      out_file: './logs/krypto-watchdog.out.log',
      error_file: './logs/krypto-watchdog.err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
