#!/usr/bin/env bash
# Roll the application back to the image that was running before the last upgrade.
#   sudo deploy/rollback.sh                       # the image recorded by the last upgrade
#   sudo deploy/rollback.sh securesend:rollback-<stamp> | ghcr.io/snelly101/lfs-upload:<tag>
#
# The chosen image is pinned as SECURESEND_IMAGE in deploy/.env so a later `docker compose up -d`
# or reboot keeps it. deploy/upgrade.sh removes a local rollback pin automatically; a registry tag
# stays until you change it.
#
# Database migrations are forward-only: if the upgrade applied a migration, restore the pre-upgrade
# database backup first (deploy/restore.sh; docs/UPGRADE.md). Compose files, Caddyfile and clamd.conf
# come from the checkout: `git checkout <commit>` the previous commit (printed below) if they changed.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
cd "$DEPLOY_DIR"

PREV="${1:-$(cat .last-image 2>/dev/null || true)}"
[ -n "$PREV" ] || die "no previous image recorded. Pass one: deploy/rollback.sh securesend:rollback-<stamp>"
case "$PREV" in
  securesend:*) docker image inspect "$PREV" >/dev/null 2>&1 || die "image $PREV is not present on this host" ;;
  *) docker pull "$PREV" ;;
esac

CURRENT="$(env_get SECURESEND_IMAGE)"
[ -n "$CURRENT" ] && echo "$CURRENT" > .image-before-rollback
env_set SECURESEND_IMAGE "$PREV"
docker compose up -d --no-build api worker
docker compose up -d --no-build --wait api || die "api did not become healthy on $PREV; inspect 'docker compose logs api'"
docker compose ps
echo
log "Rolled back to $PREV (pinned as SECURESEND_IMAGE in $ENV_FILE)."
[ -f .last-commit ] && echo "Previous deployed commit: $(cat .last-commit)  (git checkout it if deploy/ files changed in the upgrade)"
[ -f .image-before-rollback ] && echo "Image before rollback: $(cat .image-before-rollback)  (set SECURESEND_IMAGE back to it when the issue is fixed)"
echo "If the upgrade ran a migration, restore the pre-upgrade backup: sudo deploy/restore.sh <file>"
