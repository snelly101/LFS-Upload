#!/usr/bin/env bash
# Start/stop the dev API server in the background (used during development in this container).
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
case "${1:-start}" in
  start)
    if [ -f /tmp/api.pid ] && kill -0 "$(cat /tmp/api.pid)" 2>/dev/null; then kill "$(cat /tmp/api.pid)"; sleep 1; fi
    set -a; . ./.env; set +a
    nohup npx tsx src/server.ts > /tmp/api.log 2>&1 &
    echo $! > /tmp/api.pid
    for i in $(seq 1 30); do curl -sf localhost:3000/healthz >/dev/null 2>&1 && { echo "api up (pid $(cat /tmp/api.pid))"; exit 0; }; sleep 1; done
    echo "api failed to start"; tail -20 /tmp/api.log; exit 1;;
  stop)
    [ -f /tmp/api.pid ] && kill "$(cat /tmp/api.pid)" 2>/dev/null || true; rm -f /tmp/api.pid; echo stopped;;
  worker)
    if [ -f /tmp/worker.pid ] && kill -0 "$(cat /tmp/worker.pid)" 2>/dev/null; then kill "$(cat /tmp/worker.pid)"; sleep 1; fi
    set -a; . ./.env; set +a
    nohup npx tsx src/worker.ts > /tmp/worker.log 2>&1 &
    echo $! > /tmp/worker.pid; echo "worker started";;
esac
