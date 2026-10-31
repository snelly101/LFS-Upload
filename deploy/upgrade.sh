#!/usr/bin/env bash
# Upgrade to the checked-out version. Expect a short outage (single host). See docs/UPGRADE.md.
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"
PREV_IMAGE="snelson-send:rollback-$(date +%Y%m%d%H%M%S)"
if docker image inspect snelson-send:local >/dev/null 2>&1; then
  docker tag snelson-send:local "$PREV_IMAGE"
  echo "$PREV_IMAGE" > .last-image
fi
./backup.sh
docker compose build
docker compose stop api worker
docker compose run --rm --no-deps api node dist/cli.js migrate
docker compose up -d
docker compose ps
echo "Upgraded. Previous image kept as ${PREV_IMAGE:-none}; roll back with deploy/rollback.sh"
