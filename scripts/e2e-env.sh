#!/usr/bin/env bash
# Starts API, worker and the Vite dev server for browser tests (development machine only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/dev-api.sh" start
"$ROOT/scripts/dev-api.sh" worker
cd "$ROOT/apps/web"
if ! curl -sf localhost:5173 >/dev/null 2>&1; then
  nohup npx vite --port 5173 --strictPort > /tmp/vite.log 2>&1 &
  echo $! > /tmp/vite.pid
  for i in $(seq 1 30); do curl -sf localhost:5173 >/dev/null 2>&1 && break; sleep 1; done
fi
echo "e2e environment ready: api :3000, web :5173"
