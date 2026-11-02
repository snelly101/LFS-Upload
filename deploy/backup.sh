#!/usr/bin/env bash
# Database + configuration backup. The content volume (/srv/securesend/content) is INTENTIONALLY
# excluded: file bytes must not outlive their expiry in any backup or snapshot. Settings live in the
# database (secrets encrypted with SERVER_SECRET_KEY), so back up deploy/.env separately and securely:
# without SERVER_SECRET_KEY the restored database cannot decrypt TOTP seeds, SMTP or OIDC secrets.
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"
DEST="${BACKUP_DIR:-/srv/securesend/backups}"
mkdir -p "$DEST"; chmod 700 "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/securesend-db-$STAMP.dump"
docker compose exec -T db pg_dump -U securesend -d securesend -Fc > "$OUT"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ] && command -v age >/dev/null; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT.age" "$OUT" && shred -u "$OUT" && OUT="$OUT.age"
elif [ -n "${BACKUP_GPG_RECIPIENT:-}" ] && command -v gpg >/dev/null; then
  gpg --batch --yes -r "$BACKUP_GPG_RECIPIENT" -e -o "$OUT.gpg" "$OUT" && shred -u "$OUT" && OUT="$OUT.gpg"
fi
chmod 600 "$OUT"
find "$DEST" -name 'securesend-db-*' -mtime +"${BACKUP_KEEP_DAYS:-30}" -delete
echo "Backup written: $OUT (content volume excluded by design)"
