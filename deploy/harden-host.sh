#!/usr/bin/env bash
# Make the host look after itself. Idempotent and safe to re-run; prints what it changed.
#   sudo deploy/harden-host.sh                         # security updates, no automatic reboot
#   sudo deploy/harden-host.sh --enable-reboot-window  # also reboot at 03:30 when an update needs it
#   sudo deploy/harden-host.sh --disable-reboot-window # back to no automatic reboot
#
# What it does:
#   * unattended-upgrades for Ubuntu security updates only. Automatic reboot is OFF by default because
#     a reboot cuts every live upload and download; patch reboots belong in a maintenance window.
#     Docker Engine comes from Docker's own repository and is deliberately not auto-upgraded.
#   * needrestart in list-only mode (never restarts services on its own)
#   * journald size cap
#   * confirms swap is off and core dumps are disabled (plaintext must not reach unencrypted disk)
#   * Docker daemon defaults: log rotation and live-restore
#   * verifies /srv/securesend/content and /srv/securesend/db are mounted from LUKS devices
# What it deliberately does NOT do: change SSH configuration or any firewall. See the end of the output.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
require_root

REBOOT_MODE="keep"
for arg in "$@"; do
  case "$arg" in
    --enable-reboot-window) REBOOT_MODE="on" ;;
    --disable-reboot-window) REBOOT_MODE="off" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

CHANGED=0
PROBLEMS=0
changed() { CHANGED=$((CHANGED + 1)); echo "  changed: $*"; }
ok()      { echo "  ok:      $*"; }
problem() { PROBLEMS=$((PROBLEMS + 1)); echo "  PROBLEM: $*" >&2; }

# write_file PATH MODE — install stdin as PATH if the content differs.
write_file() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"; ok "$path"
    return 1
  fi
  install -D -m "$mode" "$tmp" "$path"; rm -f "$tmp"
  changed "$path"
  return 0
}

echo "== Security updates"
export DEBIAN_FRONTEND=noninteractive
MISSING=""
for pkg in unattended-upgrades needrestart; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
done
if [ -n "$MISSING" ]; then
  apt-get update -qq
  # shellcheck disable=SC2086
  apt-get install -y -qq $MISSING
  changed "installed$MISSING"
else
  ok "unattended-upgrades and needrestart installed"
fi

REBOOT_FILE=/etc/apt/apt.conf.d/53securesend-reboot
if [ "$REBOOT_MODE" = "keep" ]; then
  if [ -f "$REBOOT_FILE" ] && grep -q 'Automatic-Reboot "true"' "$REBOOT_FILE"; then REBOOT_MODE="on"; else REBOOT_MODE="off"; fi
fi

write_file /etc/apt/apt.conf.d/20auto-upgrades 644 <<'CONF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF

write_file /etc/apt/apt.conf.d/52securesend-unattended 644 <<'CONF' || true
// Managed by deploy/harden-host.sh. Security pockets only; nothing from -updates, -backports or
// third-party repositories (Docker Engine is upgraded by hand in a maintenance window).
#clear Unattended-Upgrade::Allowed-Origins;
Unattended-Upgrade::Allowed-Origins {
        "${distro_id}:${distro_codename}-security";
        "${distro_id}ESMApps:${distro_codename}-apps-security";
        "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "false";
Unattended-Upgrade::SyslogEnable "true";
CONF

if [ "$REBOOT_MODE" = "on" ]; then
  write_file "$REBOOT_FILE" 644 <<'CONF' || true
// Managed by deploy/harden-host.sh --enable-reboot-window.
// A reboot interrupts live transfers: uploads resume, single-file downloads resume, ZIP downloads restart.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:30";
CONF
  echo "  note:    automatic reboot window ENABLED at 03:30 (only when an update requires it)"
else
  write_file "$REBOOT_FILE" 644 <<'CONF' || true
// Managed by deploy/harden-host.sh. Reboots are manual: schedule them in a maintenance window.
// /var/run/reboot-required exists when one is pending; deploy/monitor-check.sh reports it.
Unattended-Upgrade::Automatic-Reboot "false";
CONF
  echo "  note:    automatic reboot is OFF; reboot by hand when /var/run/reboot-required appears"
fi

write_file /etc/needrestart/conf.d/90-securesend.conf 644 <<'CONF' || true
# Managed by deploy/harden-host.sh: list services that need a restart, never restart them automatically.
$nrconf{restart} = 'l';
$nrconf{kernelhints} = 0;
CONF
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1 || true

echo "== Logs"
if write_file /etc/systemd/journald.conf.d/90-securesend.conf 644 <<'CONF'
# Managed by deploy/harden-host.sh
[Journal]
SystemMaxUse=500M
SystemKeepFree=1G
MaxRetentionSec=3month
CONF
then systemctl restart systemd-journald; fi

echo "== Swap and core dumps"
if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
  if swapon --show=NAME --noheadings | grep -q '^/dev/mapper/\|^/dev/dm-'; then
    ok "swap is on a device-mapper (encrypted) device"
  else
    problem "unencrypted swap is active: run 'swapoff -a' and remove it from /etc/fstab, or encrypt it (docs/INSTALL.md)"
  fi
else
  ok "swap is off"
fi
write_file /etc/sysctl.d/90-securesend.conf 644 <<'CONF' || true
kernel.core_pattern=|/bin/false
fs.suid_dumpable=0
CONF
# Ubuntu's crash reporter (apport) sets fs.suid_dumpable=2 and points kernel.core_pattern at itself every
# time it starts, after the boot-time sysctl pass. It collects process memory, so it has no place here.
if systemctl list-unit-files 'apport*' --no-legend 2>/dev/null | grep -q .; then
  APPORT_UNITS="$(systemctl list-unit-files 'apport*' --no-legend 2>/dev/null | awk '{print $1}' | grep -v '@' | tr '\n' ' ')"
  # shellcheck disable=SC2086
  if systemctl is-enabled --quiet $APPORT_UNITS 2>/dev/null || systemctl is-active --quiet $APPORT_UNITS 2>/dev/null; then
    # shellcheck disable=SC2086
    systemctl disable --now $APPORT_UNITS >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    systemctl mask apport.service >/dev/null 2>&1 || true
    changed "crash reporter (apport) stopped and disabled"
  else
    ok "crash reporter (apport) is disabled"
  fi
  if [ -f /etc/default/apport ] && ! grep -q '^enabled=0' /etc/default/apport; then
    sed -i 's/^enabled=.*/enabled=0/' /etc/default/apport
    grep -q '^enabled=0' /etc/default/apport || echo 'enabled=0' >> /etc/default/apport
    changed "/etc/default/apport (enabled=0)"
  fi
fi
# Apply on every run, not only when the file changed: something else may have altered the live values.
sysctl -q -p /etc/sysctl.d/90-securesend.conf || true
if write_file /etc/systemd/system.conf.d/90-securesend-no-core.conf 644 <<'CONF'
# Managed by deploy/harden-host.sh
[Manager]
DefaultLimitCORE=0
CONF
then systemctl daemon-reexec; fi
write_file /etc/systemd/coredump.conf.d/90-securesend.conf 644 <<'CONF' || true
# Managed by deploy/harden-host.sh
[Coredump]
Storage=none
ProcessSizeMax=0
CONF
DUMPABLE="$(sysctl -n fs.suid_dumpable 2>/dev/null || echo unknown)"
if [ "$DUMPABLE" = "0" ]; then
  ok "fs.suid_dumpable=0"
else
  problem "fs.suid_dumpable is $DUMPABLE, not 0. Find what sets it: grep -rs suid_dumpable /etc/sysctl.conf /etc/sysctl.d /usr/lib/sysctl.d /run/sysctl.d"
fi
CORE_PATTERN="$(sysctl -n kernel.core_pattern 2>/dev/null || echo unknown)"
if [ "$CORE_PATTERN" = "|/bin/false" ]; then
  ok "core dumps are discarded"
else
  problem "kernel.core_pattern is '$CORE_PATTERN', not '|/bin/false'"
fi

echo "== Clock"
if command -v timedatectl >/dev/null 2>&1; then
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]; then
    ok "clock is synchronised"
  else
    problem "clock is NOT synchronised. Expiry, one-time codes and authenticator codes depend on correct time. Install systemd-timesyncd (or chrony) and allow NTP to your time source."
  fi
fi

echo "== Docker daemon"
if command -v docker >/dev/null 2>&1; then
  DAEMON=/etc/docker/daemon.json
  TMP="$(mktemp)"
  python3 - "$DAEMON" > "$TMP" <<'PY'
import json, os, sys
path = sys.argv[1]
cfg = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    with open(path) as f:
        cfg = json.load(f)
cfg.setdefault("log-driver", "json-file")
opts = cfg.setdefault("log-opts", {})
opts.setdefault("max-size", "50m")
opts.setdefault("max-file", "5")
cfg.setdefault("live-restore", True)
print(json.dumps(cfg, indent=2, sort_keys=True))
PY
  if [ -f "$DAEMON" ] && cmp -s "$TMP" "$DAEMON"; then
    ok "$DAEMON"
  else
    install -D -m 644 "$TMP" "$DAEMON"
    changed "$DAEMON (log rotation defaults, live-restore)"
    # live-restore is picked up on reload (no container restart). The log defaults apply to
    # containers created after the next daemon restart; the compose file sets them per service anyway.
    systemctl reload docker 2>/dev/null || echo "  note:    reload Docker to apply (systemctl reload docker)"
  fi
  rm -f "$TMP"
else
  echo "  note:    Docker is not installed yet; run deploy/install.sh, then re-run this script"
fi

echo "== Encrypted volumes"
for mp in /srv/securesend/content /srv/securesend/db; do
  if ! mountpoint -q "$mp"; then
    problem "$mp is not a mount point: content or database would land on the unencrypted system disk"
    continue
  fi
  src="$(findmnt -no SOURCE "$mp")"
  type="$(lsblk -no TYPE "$src" 2>/dev/null | head -n1)"
  if [ "$type" = "crypt" ]; then
    ok "$mp is on $src (LUKS)"
  else
    problem "$mp is on $src (type '${type:-unknown}'), not a LUKS device"
  fi
done
for key in /etc/securesend/luks/*.key; do
  [ -e "$key" ] || continue
  perms="$(stat -c '%a %U' "$key")"
  if [ "$perms" = "400 root" ]; then ok "$key permissions"; else chmod 400 "$key"; chown root:root "$key"; changed "$key permissions set to 0400 root"; fi
done

echo
echo "== Recommendations (not applied by this script)"
echo "  * SSH: use key-only logins (PasswordAuthentication no, PermitRootLogin no in /etc/ssh/sshd_config.d/)"
echo "    once every administrator has a key installed. Test a second session before closing the first."
echo "  * Firewall: at the DMZ firewall allow inbound 80/443 from the internet and 22 only from the"
echo "    management subnet. This host runs no local firewall; Docker publishes only 80 and 443."
echo "  * Escrow /etc/securesend/luks/*.key and the backup age private key off this host (docs/GO-LIVE.md)."
echo "  * NinjaOne: exclude this server from automatic patch reboots; reboot in a maintenance window."
[ -f /var/run/reboot-required ] && echo "  * A reboot is pending now (/var/run/reboot-required)."

echo
echo "Summary: $CHANGED change(s), $PROBLEMS problem(s)."
[ "$PROBLEMS" -eq 0 ] || exit 1
