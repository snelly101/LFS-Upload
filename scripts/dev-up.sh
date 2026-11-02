#!/usr/bin/env bash
# Bring up everything needed for local development in this container:
# PostgreSQL, clamd (EICAR-only test signatures), API, worker and the Vite dev server.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pg_lsclusters 2>/dev/null | grep -q online || pg_ctlcluster 16 main start
mkdir -p /tmp/clamtest/run
if [ ! -f /tmp/clamtest/db/eicar.ndb ]; then
  mkdir -p /tmp/clamtest/db
  printf 'Eicar-Test-Signature:0:*:58354f2150254041505b345c505a58353428505e2937434329377d2445494341522d5354414e444152442d414e544956495255532d544553542d46494c452124482b482a\n' > /tmp/clamtest/db/eicar.ndb
fi
if [ ! -f /tmp/clamtest/clamd.conf ]; then
  cat > /tmp/clamtest/clamd.conf <<CONF
LogFile /tmp/clamtest/clamd.log
PidFile /tmp/clamtest/run/clamd.pid
DatabaseDirectory /tmp/clamtest/db
TCPSocket 3310
TCPAddr 127.0.0.1
Foreground no
StreamMaxLength 100M
MaxFileSize 100M
MaxScanSize 100M
AlertExceedsMax yes
CONF
fi
pgrep -x clamd >/dev/null || clamd --config-file=/tmp/clamtest/clamd.conf
"$ROOT/scripts/e2e-env.sh"
