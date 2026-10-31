#!/usr/bin/env bash
# Start/stop the dev API server and worker in the background (development container only).
set -uo pipefail
cd "$(dirname "$0")/../apps/api"

# Kill processes whose cmdline matches $1, excluding this script and its ancestors.
killmatch() {
  local pat="$1" me="$$" pp="$PPID"
  for pid in $(pgrep -f "$pat" 2>/dev/null); do
    [ "$pid" = "$me" ] && continue; [ "$pid" = "$pp" ] && continue
    local cmd; cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null)"
    case "$cmd" in *dev-api.sh*|*"bash -c"*|*claude*) continue;; esac
    kill "$pid" 2>/dev/null || true
  done
}

case "${1:-start}" in
  start)
    killmatch "src/server.ts"; sleep 1
    set -a; . ./.env; set +a
    nohup npx tsx src/server.ts > /tmp/api.log 2>&1 &
    for i in $(seq 1 30); do curl -sf localhost:3000/healthz >/dev/null 2>&1 && { echo "api up"; exit 0; }; sleep 1; done
    echo "api failed to start"; tail -20 /tmp/api.log; exit 1;;
  stop)
    killmatch "src/server.ts"; killmatch "src/worker.ts"; echo stopped;;
  worker)
    killmatch "src/worker.ts"; sleep 1
    set -a; . ./.env; set +a
    nohup npx tsx src/worker.ts > /tmp/worker.log 2>&1 &
    echo "worker started";;
esac
