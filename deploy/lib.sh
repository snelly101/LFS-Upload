#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Source it; do not run it.
# shellcheck shell=bash

DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"

log()  { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
warn() { printf '%s WARNING: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die()  { printf '%s ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

# env_get KEY [default] — read one value from deploy/.env without sourcing the file (values such as
# SMTP_FROM contain shell metacharacters). The process environment wins over the file.
env_get() {
  local key="$1" def="${2:-}" val
  if [ -n "${!key:-}" ]; then printf '%s' "${!key}"; return 0; fi
  if [ -f "$ENV_FILE" ]; then
    val="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
    val="${val%$'\r'}"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  fi
  printf '%s' "$def"
}

# env_set KEY VALUE — set or append a key in deploy/.env, preserving everything else.
env_set() {
  local key="$1" val="$2" tmp
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  chmod 600 "$tmp"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
}

# env_unset KEY — remove a key from deploy/.env.
env_unset() {
  local key="$1" tmp
  [ -f "$ENV_FILE" ] || return 0
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  chmod 600 "$tmp"
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  mv "$tmp" "$ENV_FILE"
}

# ensure_env_defaults — add settings introduced after the first install. Safe to call repeatedly.
ensure_env_defaults() {
  [ -f "$ENV_FILE" ] || return 0
  if [ -z "$(env_get MONITOR_TOKEN)" ]; then
    env_set MONITOR_TOKEN "$(openssl rand -hex 32)"
    log "Generated MONITOR_TOKEN in $ENV_FILE (used by deploy/monitor-check.sh for GET /statusz)."
  fi
}

# Image tag of the pinned PostgreSQL image, read from docker-compose.yml so tools use the same version.
postgres_image() {
  awk '$1=="image:" && $2 ~ /^postgres:/ {print $2; exit}' "$DEPLOY_DIR/docker-compose.yml"
}

# Newest database backup file (plain or age-encrypted), or nothing.
newest_backup() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f \( -name 'securesend-db-*.dump' -o -name 'securesend-db-*.dump.age' \) -printf '%f\n' 2>/dev/null \
    | sort -r | head -n1 | sed "s|^|$dir/|"
}

# wait_for_api — wait on the api's own health check only. `up --wait api` without --no-deps also waits on
# the services it depends on, so a scanner that is still loading signatures would fail an otherwise good upgrade.
wait_for_api() {
  docker compose up -d --no-build --no-deps --wait api
}

# report_scanner — say where the scanner stands without failing the caller. Uploads stay in quarantine
# while it is down (fail closed), so this is a warning for the operator, not a reason to roll back.
report_scanner() {
  local id h
  id="$(docker compose ps -q clamav 2>/dev/null || true)"
  if [ -z "$id" ]; then
    warn "the scanner container is not running; new uploads will wait in quarantine. Start it with: docker compose up -d clamav"
    return 0
  fi
  h="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo unknown)"
  case "$h" in
    healthy)  log "Scanner: healthy." ;;
    starting) log "Scanner: still loading virus signatures (normal for several minutes after a restart). Uploads wait in quarantine until it is ready." ;;
    *)        warn "scanner health is '$h'; new uploads will wait in quarantine until it recovers. Inspect: docker compose logs --tail=50 clamav" ;;
  esac
}

require_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo $0)"; }
