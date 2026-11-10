#!/usr/bin/env bash
# Nightly database backup. Run by deploy/systemd/securesend-backup.timer; safe to run by hand.
#
# What is backed up: a logical dump of the PostgreSQL database (pg_dump custom format, compressed)
# and a copy of deploy/.env. The dump holds users, transfer metadata, recipient addresses, filenames,
# settings (secrets inside it are wrapped with SERVER_SECRET_KEY) and the audit chain.
#
# What is deliberately NOT backed up:
#   * The content volume (/srv/securesend/content). File bytes must not outlive their expiry in any
#     backup or snapshot; a content backup would silently defeat verified deletion.
#   * The LUKS key files (/etc/securesend/luks/*.key). A backup that carries the keys next to the
#     data they protect is worth nothing as encryption. Escrow them separately (docs/GO-LIVE.md).
#
# Encryption: set BACKUP_AGE_RECIPIENT (an age public key, "age1...") in deploy/.env. Without it the
# dump is written in plain text to the unencrypted system disk and this script says so loudly.
# Unencrypted files are never copied off the host.
#
# Settings (deploy/.env or environment): BACKUP_DIR, BACKUP_AGE_RECIPIENT, BACKUP_KEEP_DAILY,
# BACKUP_KEEP_WEEKLY, BACKUP_RSYNC_TARGET. Exits non-zero on any failure.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
cd "$DEPLOY_DIR"
umask 077

DEST="$(env_get BACKUP_DIR /var/backups/securesend)"
RECIPIENT="$(env_get BACKUP_AGE_RECIPIENT)"
KEEP_DAILY="$(env_get BACKUP_KEEP_DAILY 14)"
KEEP_WEEKLY="$(env_get BACKUP_KEEP_WEEKLY 8)"
RSYNC_TARGET="$(env_get BACKUP_RSYNC_TARGET)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

case "$DEST" in
  /srv/securesend/content*) die "BACKUP_DIR must not be inside the content volume" ;;
esac
mkdir -p "$DEST"; chmod 700 "$DEST"

if [ -n "$RECIPIENT" ]; then
  command -v age >/dev/null 2>&1 || die "BACKUP_AGE_RECIPIENT is set but 'age' is not installed (apt-get install -y age)"
  case "$RECIPIENT" in age1*) ;; *) die "BACKUP_AGE_RECIPIENT must be an age public key starting with age1" ;; esac
fi

docker compose ps --status running --services 2>/dev/null | grep -qx db || die "the db service is not running"

PLAIN="$DEST/.securesend-db-$STAMP.dump.partial"
FINAL_PLAIN="$DEST/securesend-db-$STAMP.dump"
cleanup() { rm -f "$PLAIN" "$DEST/.securesend-db-$STAMP.dump.age.partial" "$DEST/.securesend-env-$STAMP.partial"; }
trap cleanup EXIT

log "Dumping database to $DEST"
docker compose exec -T db pg_dump -U securesend -d securesend -Fc -Z 6 > "$PLAIN"
[ -s "$PLAIN" ] || die "pg_dump produced an empty file"
# Structural check: the archive's table of contents must be readable and contain the core tables.
TOC="$(docker compose exec -T db pg_restore --list < "$PLAIN")" || die "pg_restore could not read the dump"
for t in schema_migrations users audit_events; do
  printf '%s\n' "$TOC" | grep -q "TABLE DATA public $t " || die "dump is missing table data for $t"
done

if [ -n "$RECIPIENT" ]; then
  OUT="$DEST/securesend-db-$STAMP.dump.age"
  age -r "$RECIPIENT" -o "$DEST/.securesend-db-$STAMP.dump.age.partial" "$PLAIN"
  mv "$DEST/.securesend-db-$STAMP.dump.age.partial" "$OUT"
  shred -u "$PLAIN" 2>/dev/null || rm -f "$PLAIN"
  ENV_OUT="$DEST/securesend-env-$STAMP.age"
  age -r "$RECIPIENT" -o "$DEST/.securesend-env-$STAMP.partial" "$ENV_FILE"
  mv "$DEST/.securesend-env-$STAMP.partial" "$ENV_OUT"
else
  warn "================================================================================"
  warn "BACKUP_AGE_RECIPIENT is not set: this backup is NOT ENCRYPTED."
  warn "It contains personal data and sits on the unencrypted system disk at $DEST."
  warn "Set BACKUP_AGE_RECIPIENT in $ENV_FILE (docs/RUNBOOK-BACKUP-RESTORE.md)."
  warn "================================================================================"
  OUT="$FINAL_PLAIN"
  mv "$PLAIN" "$OUT"
  ENV_OUT="$DEST/securesend-env-$STAMP"
  cp "$ENV_FILE" "$DEST/.securesend-env-$STAMP.partial"
  mv "$DEST/.securesend-env-$STAMP.partial" "$ENV_OUT"
fi
chmod 600 "$OUT" "$ENV_OUT"
SIZE="$(stat -c %s "$OUT")"

# ---- retention: newest backup of each of the last KEEP_DAILY days, then the newest backup of each
# of the KEEP_WEEKLY ISO weeks before that. Everything else is removed. ----
prune() {
  local f base stamp day week days=0 weeks=0 last_day="" last_week="" keep
  while IFS= read -r base; do
    [ -n "$base" ] || continue
    stamp="${base#securesend-db-}"; stamp="${stamp%%.*}"
    day="${stamp%%T*}"
    week="$(date -u -d "$day" +%G-%V 2>/dev/null || echo "$day")"
    keep=0
    if [ "$day" != "$last_day" ] && [ "$days" -lt "$KEEP_DAILY" ]; then
      keep=1; days=$((days + 1)); last_day="$day"; last_week="$week"
    elif [ "$day" = "$last_day" ]; then
      keep=0   # an older backup from a day that is already represented
    elif [ "$week" != "$last_week" ] && [ "$weeks" -lt "$KEEP_WEEKLY" ]; then
      keep=1; weeks=$((weeks + 1)); last_week="$week"; last_day="$day"
    fi
    if [ "$keep" -eq 0 ]; then
      for f in "$DEST/$base" "$DEST/securesend-env-$stamp" "$DEST/securesend-env-$stamp.age"; do
        if [ -f "$f" ]; then rm -f "$f"; log "Pruned $(basename "$f")"; fi
      done
    fi
  done < <(find "$DEST" -maxdepth 1 -type f -name 'securesend-db-*.dump*' -printf '%f\n' | sort -r)
}
prune

# ---- optional off-host copy (encrypted files only) ----
if [ -n "$RSYNC_TARGET" ]; then
  if [ -z "$RECIPIENT" ]; then
    die "BACKUP_RSYNC_TARGET is set but the backup is not encrypted; refusing to copy plain text off the host"
  fi
  command -v rsync >/dev/null 2>&1 || die "BACKUP_RSYNC_TARGET is set but rsync is not installed (apt-get install -y rsync)"
  log "Copying encrypted backup to $RSYNC_TARGET"
  rsync -a --chmod=F600 -e "ssh -o BatchMode=yes -o ConnectTimeout=20" "$OUT" "$ENV_OUT" "$RSYNC_TARGET/"
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST/LAST_SUCCESS"
log "Backup complete: $OUT ($SIZE bytes; content volume and LUKS keys excluded by design)"
