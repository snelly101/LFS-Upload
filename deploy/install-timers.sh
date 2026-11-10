#!/usr/bin/env bash
# Install and enable the backup and restore-check timers. Idempotent; run as root:
#   sudo deploy/install-timers.sh
# Re-run after moving the checkout or after an upgrade that changes deploy/systemd/.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
require_root
command -v systemctl >/dev/null 2>&1 || die "systemd is required"

UNITS="securesend-backup.service securesend-backup.timer securesend-restore-check.service securesend-restore-check.timer"
for u in $UNITS; do
  sed "s|@DEPLOY_DIR@|$DEPLOY_DIR|g" "$DEPLOY_DIR/systemd/$u" > "/etc/systemd/system/$u.new"
  chmod 644 "/etc/systemd/system/$u.new"
  mv "/etc/systemd/system/$u.new" "/etc/systemd/system/$u"
done
chmod 750 "$DEPLOY_DIR/backup.sh" "$DEPLOY_DIR/restore-check.sh" "$DEPLOY_DIR/restore.sh" "$DEPLOY_DIR/monitor-check.sh" 2>/dev/null || true

# age encrypts the backups; rsync is only needed for the optional off-host copy.
if ! command -v age >/dev/null 2>&1; then
  log "Installing age (backup encryption)"
  if ! { apt-get update -qq && apt-get install -y -qq age; }; then
    warn "could not install age; backups stay unencrypted until it is installed"
  fi
fi
if [ -n "$(env_get BACKUP_RSYNC_TARGET)" ] && ! command -v rsync >/dev/null 2>&1; then
  apt-get install -y -qq rsync openssh-client || warn "could not install rsync"
fi

BACKUP_DIR_VALUE="$(env_get BACKUP_DIR /var/backups/securesend)"
mkdir -p "$BACKUP_DIR_VALUE"; chmod 700 "$BACKUP_DIR_VALUE"

systemctl daemon-reload
systemctl enable --now securesend-backup.timer securesend-restore-check.timer

if [ -z "$(env_get BACKUP_AGE_RECIPIENT)" ]; then
  warn "BACKUP_AGE_RECIPIENT is not set in $ENV_FILE: backups will be written UNENCRYPTED."
  warn "Create a key pair on an admin workstation (age-keygen -o securesend-backup.key), put the"
  warn "public key (age1...) in BACKUP_AGE_RECIPIENT and keep the private key in your secrets vault."
fi

echo
echo "Timers installed. Backups go to $BACKUP_DIR_VALUE."
systemctl list-timers --all --no-pager | grep -E 'NEXT|securesend-' || true
echo
echo "Run one now and check the result:"
echo "  systemctl start securesend-backup.service && journalctl -u securesend-backup.service -n 20 --no-pager"
echo "  systemctl start securesend-restore-check.service && journalctl -u securesend-restore-check.service -n 30 --no-pager"
