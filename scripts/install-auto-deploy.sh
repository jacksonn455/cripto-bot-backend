#!/usr/bin/env bash
# Installs (or updates) the crontab entry that runs scripts/auto-deploy.sh every 5 minutes.
# Idempotent: re-running replaces the previous entry. Run on the VM as the user that owns PM2:
#   bash /home/ubuntu/krypto/backend/scripts/install-auto-deploy.sh            # install / update
#   bash /home/ubuntu/krypto/backend/scripts/install-auto-deploy.sh --remove   # uninstall
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="# krypto-auto-deploy"
INTERVAL="${AUTO_DEPLOY_INTERVAL_MINUTES:-5}"

current="$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)"

if [ "${1:-}" = "--remove" ]; then
  printf '%s\n' "$current" | sed '/^$/d' | crontab -
  echo "auto-deploy removed from crontab"
  exit 0
fi

for cmd in git node pm2 corepack flock curl; do
  command -v "$cmd" >/dev/null || { echo "install-auto-deploy: '$cmd' not found in PATH" >&2; exit 1; }
done
[ -f "$APP_DIR/.env" ] || { echo "install-auto-deploy: $APP_DIR/.env not found" >&2; exit 1; }

# cron runs with a minimal PATH; pin the one that finds node/pm2/corepack now (nvm, /usr/local/bin...).
entry="*/$INTERVAL * * * * PATH=$PATH /bin/bash $APP_DIR/scripts/auto-deploy.sh >> $APP_DIR/logs/auto-deploy.log 2>&1 $MARKER"
mkdir -p "$APP_DIR/logs"
{ printf '%s\n' "$current" | sed '/^$/d'; echo "$entry"; } | crontab -

echo "auto-deploy installed (every $INTERVAL min). Current crontab:"
crontab -l | grep "$MARKER"
