#!/usr/bin/env bash
# Restore the database from a backup produced by deploy/backup.sh.
# Read docs/RUNBOOK-BACKUP-RESTORE.md first.
#
#   sudo deploy/restore.sh /var/backups/securesend/securesend-db-<stamp>.dump[.age] [--yes]
#
# Encrypted backups need the age identity (private key) that matches BACKUP_AGE_RECIPIENT:
# pass BACKUP_AGE_IDENTITY_FILE=/path/to/key.txt or set it in deploy/.env.
#
# Safety properties relied upon after a restore:
#  - access is decided by server time and persisted expiry/deletion flags, so restored metadata cannot
#    re-enable access to transfers whose expiry has passed;
#  - the content volume is not restored; the reconcile sweep removes any bytes that no live row owns and
#    marks transfers whose bytes are gone as deletion pending/failed for operator review.
# The dump is streamed straight into PostgreSQL; no decrypted copy is written to disk.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
cd "$DEPLOY_DIR"

SRC="${1:?usage: restore.sh <backup file> [--yes]}"
CONFIRM="${2:-}"
[ -f "$SRC" ] || die "backup file not found: $SRC"
IDENTITY="$(env_get BACKUP_AGE_IDENTITY_FILE)"

stream_dump() {
  case "$SRC" in
    *.age)
      command -v age >/dev/null 2>&1 || die "'age' is not installed (apt-get install -y age)"
      if [ -z "$IDENTITY" ] || [ ! -f "$IDENTITY" ]; then die "encrypted backup: set BACKUP_AGE_IDENTITY_FILE to the age identity file"; fi
      age -d -i "$IDENTITY" "$SRC" ;;
    *) cat "$SRC" ;;
  esac
}

if [ "$CONFIRM" != "--yes" ]; then
  echo "This replaces the live database with: $SRC"
  echo "The current database is kept as securesend_old_<epoch> until you drop it."
  read -r -p "Type RESTORE to continue: " answer
  [ "$answer" = "RESTORE" ] || die "aborted"
fi

docker compose up -d --wait db
log "Stopping api and worker"
docker compose stop api worker
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U securesend -d postgres \
  -c "DROP DATABASE IF EXISTS securesend_restore;" -c "CREATE DATABASE securesend_restore OWNER securesend;"
log "Restoring into scratch database"
stream_dump | docker compose exec -T db pg_restore -U securesend -d securesend_restore --no-owner --no-privileges --exit-on-error
N="$(docker compose exec -T db psql -U securesend -d securesend_restore -Atc 'SELECT count(*) FROM schema_migrations')"
[ "${N:-0}" -ge 1 ] || die "restored database has no schema_migrations rows; live database left untouched"
OLD="securesend_old_$(date +%s)"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U securesend -d postgres \
  -c "ALTER DATABASE securesend RENAME TO $OLD;" -c "ALTER DATABASE securesend_restore RENAME TO securesend;"
docker compose run --rm --no-deps api node dist/cli.js migrate
docker compose up -d
log "Restored. Previous database kept as $OLD (drop it once you are satisfied)."
echo "The worker's startup pass expires overdue transfers and the hourly reconcile removes orphaned content."
echo "Verify in Administration → System health that the audit chain verifies and no deletion backlog remains."
