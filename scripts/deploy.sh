#!/usr/bin/env bash
# Update deploy on the Oracle VM: pull, install, build, (re)start under PM2, verify /health.
# Usage (on the VM, from anywhere):  bash /home/ubuntu/krypto/backend/scripts/deploy.sh
# First-time setup (clone, .env, pm2 startup) is in docs/DEPLOY_ORACLE.md.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${DEPLOY_BRANCH:-master}"
# pnpm through corepack (version pinned by "packageManager" in package.json); no global install
# or root needed, and no interactive "download pnpm?" prompt.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
PNPM=(corepack pnpm)

fail() { echo "deploy: ERROR: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

cd "$APP_DIR"
[ -f .env ] || fail ".env not found in $APP_DIR (copy .env.example and fill it in)"
command -v pm2 >/dev/null || fail "pm2 not installed (sudo npm install -g pm2)"
command -v corepack >/dev/null || fail "corepack not found (ships with Node.js >= 16.10)"

# Port the API listens on (same default as the app), for the health check below.
PORT="$(grep -E '^PORT=' .env | tail -n1 | cut -d= -f2- | tr -d "\"' \r" || true)"
PORT="${PORT:-8000}"

step "git pull ($BRANCH)"
git fetch --prune origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
echo "at $(git log -1 --format='%h %s')"

step "install dependencies (frozen lockfile)"
"${PNPM[@]}" install --frozen-lockfile

step "build (heap capped for the 1 GB VM)"
# nest build wipes dist/ first (deleteOutDir). Keep the previous build so a failed one never leaves
# PM2 without dist/main.js: the running worker would survive, but its next restart would not.
rm -rf dist.prev
if [ -f dist/main.js ]; then cp -a dist dist.prev; fi
restore_previous_build() {
  if [ -d dist.prev ]; then rm -rf dist && mv dist.prev dist && echo "previous build restored to dist/" >&2; fi
}
if ! NODE_OPTIONS=--max-old-space-size=1024 "${PNPM[@]}" run build || [ ! -f dist/main.js ]; then
  restore_previous_build
  fail "build failed (the running process was not touched)"
fi
rm -rf dist.prev

step "pm2 startOrReload"
mkdir -p logs
pm2 startOrReload ecosystem.config.js --env production --update-env
pm2 save

step "health check http://127.0.0.1:${PORT}/health"
# Boot (Mongo connect, first tick) takes a few seconds: retry for up to ~60 s. 503 (stalled loop)
# fails curl -f; "status":"down" (MongoDB unreachable) is answered with 200, so check the body too.
body=""
for _ in $(seq 1 30); do
  if body="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health")" && ! grep -q '"status":"down"' <<<"$body"; then
    echo "$body"
    echo
    echo "deploy: OK ($(git log -1 --format='%h'))"
    exit 0
  fi
  sleep 2
done
if [ -n "$body" ]; then echo "last /health response: $body" >&2; fi
echo "--- last log lines ---" >&2
pm2 logs krypto-backend --lines 40 --nostream >&2 || true
fail "backend did not answer /health on 127.0.0.1:${PORT} after 60 s (see logs above; pm2 status)"
