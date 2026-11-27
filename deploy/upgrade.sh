#!/usr/bin/env bash
# Upgrade to the checked-out version. Expect a short outage (single host). See docs/UPGRADE.md.
#   cd /opt/securesend && git pull && sudo deploy/upgrade.sh
#
# Two modes, chosen by SECURESEND_IMAGE in deploy/.env:
#   * empty  → the image is built on this host from the checkout (needs outbound access to the npm registry);
#   * set    → the published image is pulled (ghcr.io/...), nothing is compiled on this host.
# In both modes: pre-upgrade database backup, previous image kept for rollback, migrations applied
# after PostgreSQL reports healthy, services started, health awaited, status printed.
# SKIP_BACKUP=1 skips the pre-upgrade backup (not recommended).
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
cd "$DEPLOY_DIR"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found; run deploy/install.sh first"

ensure_env_defaults

# A rollback pins SECURESEND_IMAGE to a local securesend:rollback-* tag. Upgrading means leaving it.
PINNED="$(env_get SECURESEND_IMAGE)"
case "$PINNED" in
  securesend:rollback-*)
    log "Removing rollback pin ($PINNED); the checked-out version will be built."
    env_unset SECURESEND_IMAGE; PINNED="" ;;
esac

# ---- remember what is running now, for rollback ----
STAMP="$(date +%Y%m%d%H%M%S)"
PREV_IMAGE=""
API_CONTAINER="$(docker compose ps -q api 2>/dev/null | head -n1 || true)"
if [ -n "$API_CONTAINER" ]; then
  IMAGE_ID="$(docker inspect --format '{{.Image}}' "$API_CONTAINER" 2>/dev/null || true)"
  if [ -n "$IMAGE_ID" ]; then
    PREV_IMAGE="securesend:rollback-$STAMP"
    docker tag "$IMAGE_ID" "$PREV_IMAGE"
    echo "$PREV_IMAGE" > .last-image
  fi
fi
[ -f .deployed-commit ] && cp .deployed-commit .last-commit

# ---- pre-upgrade backup ----
if [ "${SKIP_BACKUP:-0}" = "1" ]; then
  warn "SKIP_BACKUP=1: no pre-upgrade backup taken"
elif docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  ./backup.sh
else
  warn "db is not running; no pre-upgrade backup taken"
fi

# ---- get the new image ----
if [ -n "$PINNED" ]; then
  log "Pulling $PINNED"
  docker compose pull api worker
else
  log "Building the application image from this checkout"
  docker compose build
fi
docker compose pull --quiet caddy db clamav || warn "could not pull third-party images; using the local copies"

# ---- migrate and restart ----
docker compose up -d --wait db
docker compose stop api worker
docker compose run --rm --no-deps api node dist/cli.js migrate
docker compose up -d
log "Waiting for the api to report healthy"
wait_for_api || die "api did not become healthy; inspect 'docker compose logs api' and consider deploy/rollback.sh"
report_scanner

git -C "$DEPLOY_DIR/.." rev-parse HEAD > .deployed-commit 2>/dev/null || true
docker compose ps
# Keep the three most recent rollback images.
docker image ls --format '{{.Repository}}:{{.Tag}}' 'securesend' | grep '^securesend:rollback-' | sort -r | tail -n +4 | xargs -r docker image rm >/dev/null 2>&1 || true
echo
log "Upgraded to $(cat .deployed-commit 2>/dev/null || echo unknown)$( [ -n "$PINNED" ] && echo " using $PINNED" )."
echo "Previous image: ${PREV_IMAGE:-none}. Roll back with: sudo deploy/rollback.sh"
echo "Check: sudo deploy/monitor-check.sh   and Administration → System health."
