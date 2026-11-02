#!/usr/bin/env bash
# Idempotent first-time installation on Ubuntu 24.04 LTS or 26.04 LTS (Docker repo channel is chosen from the release codename). Run as root from the repository checkout:
#   sudo deploy/install.sh admin@example.com
# Prerequisites that this script does NOT do for you (see docs/INSTALL.md):
#   - DNS A/AAAA record for PUBLIC_HOST pointing at this server, ports 80/443 reachable
#   - LUKS-encrypted filesystems mounted at /srv/securesend/content and /srv/securesend/db
#   - swap encrypted or disabled, core dumps disabled
set -euo pipefail
ADMIN_EMAIL="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker Engine from the official repository..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

for d in /srv/securesend/content /srv/securesend/db; do
  if ! mountpoint -q "$d"; then
    echo "WARNING: $d is not a separate mount. Production requires a LUKS-encrypted volume here (docs/INSTALL.md)." >&2
    mkdir -p "$d"
  fi
done
# api/worker run as uid 10001 and own the content tree; postgres image manages /srv/securesend/db itself.
chown 10001:10001 /srv/securesend/content
chmod 700 /srv/securesend/content

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^SERVER_SECRET_KEY=.*|SERVER_SECRET_KEY=$(openssl rand -base64 48)|" .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')|" .env
  chmod 600 .env
  echo "Created $HERE/.env with generated secrets."
  echo "Next: edit PUBLIC_HOST, PUBLIC_URL, ACME_EMAIL and SMTP settings in $HERE/.env, then run:  bash $HERE/install.sh [admin-email]"
  exit 0
fi

docker compose build
docker compose up -d db clamav
docker compose run --rm --no-deps api node dist/cli.js migrate
docker compose up -d
if [ -n "$ADMIN_EMAIL" ]; then
  docker compose run --rm --no-deps api node dist/cli.js bootstrap-admin "$ADMIN_EMAIL"
fi
echo "Done. All docker compose commands run from $HERE (cd $HERE first)."
echo "Check:  docker compose ps   and   curl -fsS https://$(grep ^PUBLIC_HOST= .env | cut -d= -f2)/readyz"
if [ -z "$ADMIN_EMAIL" ]; then
  echo "Create the first administrator:  docker compose run --rm --no-deps api node dist/cli.js bootstrap-admin you@example.com"
fi
