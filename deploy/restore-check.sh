#!/usr/bin/env bash
# Monthly restore check, run by deploy/systemd/securesend-restore-check.timer.
#
# Restores the newest backup into a throwaway PostgreSQL container (same pinned image as production)
# on an isolated network with RAM-backed storage, runs sanity queries, and tears everything down.
# The live database is never touched. On success the result is recorded in the application so
# Administration → System health shows when a restore was last proven.
#
# Encrypted backups: with BACKUP_AGE_IDENTITY_FILE available on this host the actual newest backup
# file is decrypted and restored. Without it, the script proves the dump/restore pipeline with a
# fresh dump (streamed, never written to disk) and only checks the newest encrypted file's header;
# the recorded note says so, and you must test decryption off-host (docs/RUNBOOK-BACKUP-RESTORE.md).
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
cd "$DEPLOY_DIR"

DEST="$(env_get BACKUP_DIR /var/backups/securesend)"
IDENTITY="$(env_get BACKUP_AGE_IDENTITY_FILE)"
TMPFS_MB="$(env_get RESTORE_CHECK_TMPFS_MB 1024)"
IMAGE="$(postgres_image)"
[ -n "$IMAGE" ] || die "could not read the postgres image from docker-compose.yml"
NAME="securesend-restorecheck-$$"
NET="securesend-restorecheck-net-$$"
PW="$(openssl rand -hex 16)"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

LATEST="$(newest_backup "$DEST")"
[ -n "$LATEST" ] || die "no backup found in $DEST; run deploy/backup.sh first"
AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$LATEST") ) / 3600 ))
MODE="artifact"
case "$LATEST" in
  *.age)
    command -v age >/dev/null 2>&1 || die "'age' is not installed"
    head -c 32 "$LATEST" | grep -q '^age-encryption.org/v1' || die "$LATEST does not look like an age file"
    if [ -z "$IDENTITY" ] || [ ! -f "$IDENTITY" ]; then MODE="pipeline"; fi ;;
esac

stream_dump() {
  if [ "$MODE" = "pipeline" ]; then
    docker compose exec -T db pg_dump -U securesend -d securesend -Fc
  else
    case "$LATEST" in
      *.age) age -d -i "$IDENTITY" "$LATEST" ;;
      *) cat "$LATEST" ;;
    esac
  fi
}

log "Restore check using $IMAGE (mode: $MODE, newest backup: $(basename "$LATEST"), ${AGE_H} h old)"
docker network create --internal "$NET" >/dev/null
docker run -d --name "$NAME" --network "$NET" \
  --tmpfs "/var/lib/postgresql/data:rw,size=${TMPFS_MB}m" \
  --security-opt no-new-privileges:true --memory 2g \
  -e POSTGRES_USER=securesend -e POSTGRES_DB=securesend -e POSTGRES_PASSWORD="$PW" \
  "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -q -U securesend -d securesend -h 127.0.0.1 2>/dev/null; then ready=1; break; fi
  sleep 2
done
# pg_isready is checked over TCP on purpose: the image's first-run initialisation server only listens
# on the unix socket, so a TCP answer means the real server is up.
[ "$ready" -eq 1 ] || die "throwaway PostgreSQL did not become ready"

stream_dump | docker exec -i "$NAME" pg_restore -U securesend -d securesend --no-owner --no-privileges --exit-on-error

q() { docker exec "$NAME" psql -U securesend -d securesend -v ON_ERROR_STOP=1 -Atc "$1"; }
MIGRATIONS="$(q 'SELECT count(*) FROM schema_migrations')"
USERS="$(q 'SELECT count(*) FROM users')"
AUDIT="$(q 'SELECT count(*) FROM audit_events')"
LAST_AUDIT="$(q "SELECT coalesce(to_char(max(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI\"Z\"'), 'none') FROM audit_events")"
[ "${MIGRATIONS:-0}" -ge 1 ] || die "restored database has no schema_migrations rows"
[ "${USERS:-0}" -ge 1 ] || die "restored database has no users"
LIVE_MIGRATIONS="$(docker compose exec -T db psql -U securesend -d securesend -Atc 'SELECT count(*) FROM schema_migrations' 2>/dev/null || echo '?')"

if [ "$MODE" = "artifact" ]; then
  NOTE="Automated restore check: restored $(basename "$LATEST") (${AGE_H} h old) into throwaway PostgreSQL; ${MIGRATIONS} migrations (live ${LIVE_MIGRATIONS}), ${USERS} users, ${AUDIT} audit rows, newest audit ${LAST_AUDIT}. Content volume excluded by design."
else
  NOTE="Automated restore check (pipeline only): fresh dump restored into throwaway PostgreSQL; ${MIGRATIONS} migrations, ${USERS} users, ${AUDIT} audit rows. Newest encrypted backup $(basename "$LATEST") NOT decrypted on this host; test decryption off-host."
fi
log "$NOTE"

if docker compose run --rm --no-deps api node dist/cli.js record-backup-verification "$NOTE"; then
  log "Recorded in the application (Administration → System health → Backup verification)."
else
  warn "could not record the result in the application (is the api image up to date?); the check itself passed"
fi
date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST/LAST_RESTORE_CHECK"
log "Restore check passed."
