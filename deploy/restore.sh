#!/usr/bin/env bash
# Restore the database from a backup produced by deploy/backup.sh. Read docs/RUNBOOK-BACKUP-RESTORE.md first.
# Safety properties relied upon after a restore:
#  - access is decided by server time and persisted expiry/deletion flags, so restored metadata cannot
#    re-enable access to transfers whose expiry has passed;
#  - the content volume is not restored; the reconcile sweep removes any bytes that no live row owns and
#    marks transfers whose bytes are gone as deletion pending/failed for operator review.
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"
SRC="${1:?usage: restore.sh <backup file>}"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
case "$SRC" in
  *.age) age -d -o "$TMP" "$SRC" ;;
  *.gpg) gpg --batch -d -o "$TMP" "$SRC" ;;
  *) cp "$SRC" "$TMP" ;;
esac
docker compose stop api worker
docker compose exec -T db psql -U securesend -d postgres -c "DROP DATABASE IF EXISTS securesend_restore;" -c "CREATE DATABASE securesend_restore OWNER securesend;"
docker compose exec -T db pg_restore -U securesend -d securesend_restore --no-owner --no-privileges < "$TMP"
docker compose exec -T db psql -U securesend -d postgres -c "ALTER DATABASE securesend RENAME TO securesend_old_$(date +%s);" -c "ALTER DATABASE securesend_restore RENAME TO securesend;"
docker compose run --rm --no-deps api node dist/cli.js migrate
docker compose up -d
echo "Restored. The worker's startup pass expires overdue transfers and the hourly reconcile removes orphaned content."
echo "Verify in Administration → System health that the audit chain verifies and no deletion backlog remains."
