#!/usr/bin/env bash
# Roll back the application image to the previous build. Database migrations are forward-only:
# if the upgrade applied a migration, restore the pre-upgrade database backup first (docs/UPGRADE.md).
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"
PREV="${1:-$(cat .last-image 2>/dev/null || true)}"
[ -n "$PREV" ] || { echo "No previous image recorded. Pass a tag: deploy/rollback.sh securesend:rollback-<stamp>"; exit 1; }
docker tag "$PREV" securesend:local
docker compose up -d --no-build api worker
docker compose ps
