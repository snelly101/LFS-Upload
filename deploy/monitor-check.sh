#!/usr/bin/env bash
# One-shot health check for an RMM (NinjaOne) or cron. Prints a one-line summary first, then one line
# per check that is not ok. Exit code: 0 = ok, 1 = warning, 2 = failure.
#   sudo /opt/securesend/deploy/monitor-check.sh
# Checks: compose services, the application's own status (GET /statusz with MONITOR_TOKEN), encrypted
# volumes, backup age, backup/restore-check units, TLS certificate lifetime (TLS_MODE=acme), disk
# space on the system disk and a pending reboot. It reads nothing sensitive and prints no secrets.
set -uo pipefail
# shellcheck source=deploy/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
cd "$DEPLOY_DIR" || exit 2

SEVERITY=0
SUMMARY=""
DETAILS=""
note() { # note NAME STATE [detail]   STATE = ok|warn|fail
  local name="$1" state="$2" detail="${3:-}"
  SUMMARY="$SUMMARY $name=$state"
  case "$state" in
    warn) [ "$SEVERITY" -lt 1 ] && SEVERITY=1 ;;
    fail) SEVERITY=2 ;;
  esac
  if [ "$state" != "ok" ] && [ -n "$detail" ]; then DETAILS="$DETAILS
$state: $name: $detail"; fi
  return 0
}

PUBLIC_HOST_VALUE="$(env_get PUBLIC_HOST)"
TLS_MODE_VALUE="$(env_get TLS_MODE acme)"
TOKEN="$(env_get MONITOR_TOKEN)"
BACKUP_DIR_VALUE="$(env_get BACKUP_DIR /var/backups/securesend)"
BACKUP_MAX_AGE_H="$(env_get BACKUP_MAX_AGE_HOURS 36)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---- 1. containers --------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  note services fail "Docker is not running"
else
  PS_OUT="$(docker compose ps -a --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null)"
  svc_state="ok"; svc_detail=""
  for svc in caddy api worker db clamav; do
    line="$(printf '%s\n' "$PS_OUT" | awk -v s="$svc" '$1==s {print; exit}')"
    state="$(printf '%s' "$line" | awk '{print $2}')"
    health="$(printf '%s' "$line" | awk '{print $3}')"
    if [ "$state" != "running" ]; then
      svc_state="fail"; svc_detail="$svc_detail $svc:${state:-missing}"
    elif [ "$health" = "unhealthy" ]; then
      svc_state="fail"; svc_detail="$svc_detail $svc:unhealthy"
    elif [ "$health" = "starting" ]; then
      [ "$svc_state" = "ok" ] && svc_state="warn"; svc_detail="$svc_detail $svc:starting"
    fi
  done
  note services "$svc_state" "${svc_detail# }"
fi

# ---- 2. application status ------------------------------------------------------------------
fetch_statusz() { # prints "<http code> <body>"
  local cacert_args=() code
  [ -n "$PUBLIC_HOST_VALUE" ] || return 1
  if [ "$TLS_MODE_VALUE" = "internal" ]; then
    docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/root.crt" >/dev/null 2>&1 || return 1
    cacert_args=(--cacert "$WORK/root.crt")
  fi
  code="$(curl -sS -m 15 -o "$WORK/statusz.json" -w '%{http_code}' "${cacert_args[@]}" \
    --resolve "$PUBLIC_HOST_VALUE:443:127.0.0.1" -H "Authorization: Bearer $TOKEN" \
    "https://$PUBLIC_HOST_VALUE/statusz" 2>/dev/null)" || return 1
  printf '%s %s' "$code" "$(cat "$WORK/statusz.json" 2>/dev/null)"
}
fetch_statusz_direct() { # fallback: ask the api container itself (the token is already in its environment)
  docker compose exec -T api node -e '
    fetch("http://127.0.0.1:3000/statusz", { headers: { authorization: "Bearer " + (process.env.MONITOR_TOKEN || "") } })
      .then(async (r) => { process.stdout.write(r.status + " " + (await r.text())); })
      .catch(() => { process.stdout.write("000 "); });' 2>/dev/null
}
if [ -z "$TOKEN" ]; then
  note app warn "MONITOR_TOKEN is not set in deploy/.env (run deploy/upgrade.sh or deploy/install.sh to generate it)"
else
  RESP="$(fetch_statusz || true)"
  VIA="proxy"
  case "$RESP" in 200\ *|503\ *) ;; *) RESP="$(fetch_statusz_direct || true)"; VIA="direct" ;; esac
  CODE="${RESP%% *}"; BODY="${RESP#* }"
  case "$CODE" in
    200|503)
      BAD="$(printf '%s' "$BODY" | grep -oE '"[a-z_]+":"(warn|fail)"' | tr -d '"' | tr '\n' ' ')"
      if printf '%s' "$BODY" | grep -q '"fail"'; then note app fail "${BAD% }"
      elif [ "$CODE" = "503" ]; then note app fail "status endpoint returned 503 ${BAD% }"
      elif printf '%s' "$BODY" | grep -q '"warn"'; then note app warn "${BAD% }"
      else note app ok; fi
      if [ "$VIA" = "direct" ]; then
        if command -v curl >/dev/null 2>&1; then
          note proxy fail "the application answers inside its container but not through Caddy on https://$PUBLIC_HOST_VALUE"
        else
          note proxy warn "curl is not installed, so the path through Caddy was not checked (apt-get install -y curl)"
        fi
      fi ;;
    404) note app warn "GET /statusz returned 404: MONITOR_TOKEN is not loaded by the api container (docker compose up -d api) or the image predates the endpoint" ;;
    401|403) note app warn "GET /statusz rejected the token: recreate the api container so it reads the current deploy/.env" ;;
    *) note app fail "no answer from the application (GET /statusz: ${CODE:-no response})" ;;
  esac
fi

# ---- 3. encrypted volumes -------------------------------------------------------------------
vol_state="ok"; vol_detail=""
for mp in /srv/securesend/content /srv/securesend/db; do
  if ! mountpoint -q "$mp"; then vol_state="fail"; vol_detail="$vol_detail $mp:not-mounted"; continue; fi
  src="$(findmnt -no SOURCE "$mp" 2>/dev/null)"
  type="$(lsblk -no TYPE "$src" 2>/dev/null | head -n1)"
  [ "$type" = "crypt" ] || { vol_state="fail"; vol_detail="$vol_detail $mp:not-encrypted"; }
done
note volumes "$vol_state" "${vol_detail# }"

# ---- 4. backups -----------------------------------------------------------------------------
LATEST="$(newest_backup "$BACKUP_DIR_VALUE")"
if [ -z "$LATEST" ]; then
  note backup fail "no backup found in $BACKUP_DIR_VALUE (sudo deploy/install-timers.sh)"
else
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$LATEST") ) / 3600 ))
  if [ "$age_h" -ge "$BACKUP_MAX_AGE_H" ]; then
    note backup fail "newest backup is ${age_h} h old (limit ${BACKUP_MAX_AGE_H} h)"
  else
    case "$LATEST" in
      *.age) note backup ok ;;
      *) note backup warn "newest backup is not encrypted (set BACKUP_AGE_RECIPIENT)" ;;
    esac
  fi
fi
if command -v systemctl >/dev/null 2>&1; then
  for unit in securesend-backup.service securesend-restore-check.service; do
    if systemctl is-failed --quiet "$unit" 2>/dev/null; then note "${unit%.service}" fail "last run failed (journalctl -u $unit)"; fi
  done
  systemctl is-enabled --quiet securesend-backup.timer 2>/dev/null || note backup-timer warn "securesend-backup.timer is not enabled (sudo deploy/install-timers.sh)"
fi

# ---- 5. TLS certificate ---------------------------------------------------------------------
if [ "$TLS_MODE_VALUE" = "acme" ] && [ -n "$PUBLIC_HOST_VALUE" ] && command -v openssl >/dev/null 2>&1; then
  if openssl s_client -connect 127.0.0.1:443 -servername "$PUBLIC_HOST_VALUE" </dev/null > "$WORK/cert.txt" 2>/dev/null \
     && openssl x509 -in "$WORK/cert.txt" -noout >/dev/null 2>&1; then
    if ! openssl x509 -in "$WORK/cert.txt" -noout -checkend $((3 * 86400)) >/dev/null 2>&1; then
      note tls fail "certificate for $PUBLIC_HOST_VALUE expires within 3 days or has expired"
    elif ! openssl x509 -in "$WORK/cert.txt" -noout -checkend $((14 * 86400)) >/dev/null 2>&1; then
      note tls warn "certificate for $PUBLIC_HOST_VALUE expires within 14 days (Caddy should have renewed it; check 'docker compose logs caddy')"
    else
      note tls ok
    fi
  else
    note tls fail "no certificate served on 443 for $PUBLIC_HOST_VALUE"
  fi
elif [ "$TLS_MODE_VALUE" = "internal" ]; then
  note tls warn "TLS_MODE=internal (test certificate); switch to acme for go-live"
fi

# ---- 6. host --------------------------------------------------------------------------------
root_used="$(df --output=pcent / 2>/dev/null | tail -n1 | tr -dc '0-9')"
if [ -n "$root_used" ]; then
  if [ "$root_used" -ge 95 ]; then note system-disk fail "system disk is ${root_used}% full"
  elif [ "$root_used" -ge 85 ]; then note system-disk warn "system disk is ${root_used}% full"
  else note system-disk ok; fi
fi
[ -f /var/run/reboot-required ] && note reboot warn "a reboot is pending after security updates; schedule a maintenance window"

case "$SEVERITY" in
  0) echo "SECURESEND OK |$SUMMARY" ;;
  1) echo "SECURESEND WARNING |$SUMMARY" ;;
  *) echo "SECURESEND FAILURE |$SUMMARY" ;;
esac
[ -n "$DETAILS" ] && printf '%s\n' "${DETAILS#$'\n'}"
exit "$SEVERITY"
