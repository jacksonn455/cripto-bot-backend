#!/usr/bin/env bash
# Pull-based continuous deploy for the Oracle VM: run by cron every few minutes, it checks
# origin/master and runs scripts/deploy.sh only when there is a new commit, then reports the
# result on Discord (scripts/deploy-notify.js). The VM polls GitHub, so no inbound port or deploy
# key is needed. Install once with scripts/install-auto-deploy.sh (docs/DEPLOY_ORACLE.md, section 10).
#
# A commit whose deploy failed is not retried every tick: it waits for the next commit (or a manual
# `bash scripts/deploy.sh`). Pausing: `touch .deploy-state/paused` (rm to resume).
set -euo pipefail

main() {
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  BRANCH="${DEPLOY_BRANCH:-master}"
  STATE_DIR="$APP_DIR/.deploy-state"
  mkdir -p "$STATE_DIR" "$APP_DIR/logs"
  cd "$APP_DIR"

  # One run at a time: a deploy (install + build) can take longer than the cron interval.
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || exit 0

  [ -f "$STATE_DIR/paused" ] && exit 0

  git fetch --quiet --prune origin "$BRANCH"
  local current target
  current="$(git rev-parse HEAD)"
  target="$(git rev-parse "origin/$BRANCH")"
  [ "$current" = "$target" ] && exit 0

  # Already failed on this exact commit: wait for a new one instead of failing (and alerting) every tick.
  if [ "$(cat "$STATE_DIR/failed-sha" 2>/dev/null || true)" = "$target" ]; then exit 0; fi

  local short changes started log
  short="$(git rev-parse --short "$target")"
  changes="$(git log --format='• %h %s' -n 10 "$current..$target" 2>/dev/null || true)"
  started="$(date +%s)"
  log="$APP_DIR/logs/deploy-$(date +%Y%m%d-%H%M%S)-$short.log"
  echo "$(date -Is) auto-deploy: $(git rev-parse --short "$current") -> $short (log: $log)"

  if bash "$APP_DIR/scripts/deploy.sh" >"$log" 2>&1; then
    rm -f "$STATE_DIR/failed-sha"
    local took=$(( $(date +%s) - started ))
    echo "$(date -Is) auto-deploy: OK $short in ${took}s"
    notify success "Deploy concluído · $short" "$changes" "${took}s" "$log"
  else
    echo "$target" >"$STATE_DIR/failed-sha"
    local step
    step="$(grep -E '^==> ' "$log" | tail -n1 | sed 's/^==> //' || true)"
    echo "$(date -Is) auto-deploy: FAILED $short at step: ${step:-?}"
    notify failure "Deploy falhou · $short" "Etapa: ${step:-desconhecida}"$'\n'"$changes" "" "$log"
  fi

  # Keep the 30 most recent deploy logs.
  ls -1t "$APP_DIR"/logs/deploy-*.log 2>/dev/null | tail -n +31 | xargs -r rm -f
}

# notify <success|failure> <title> <description> <duration> <log file>. Never fails the run.
notify() {
  node --env-file="$APP_DIR/.env" "$APP_DIR/scripts/deploy-notify.js" "$@" || echo "auto-deploy: Discord notification failed" >&2
}

main "$@"
exit
