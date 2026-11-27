# Upgrade and rollback

Single-host deployment: upgrades cause a short outage (typically under two minutes). In-flight uploads
resume automatically afterwards (tus); in-flight downloads must be restarted (individual files resume via
Range; ZIP downloads restart from the beginning).

## Two ways to get the new version onto the server
| | Build on the server (default) | Pull a published image |
|---|---|---|
| `SECURESEND_IMAGE` in `deploy/.env` | empty | e.g. `ghcr.io/snelly101/lfs-upload:1.2.0` |
| What `deploy/upgrade.sh` does | `docker compose build` from the checkout | `docker compose pull api worker` |
| Server needs outbound access to | npm registry, Docker Hub | `ghcr.io`, `pkg-containers.githubusercontent.com`, Docker Hub |
| Where the code is compiled and tested | on the production host, untested | in GitHub Actions (`.github/workflows/ci.yml`): typecheck, web build and the integration tests must pass before the image is pushed |

Images are published by the `image` job on every push to `main` (tags `main` and `sha-<commit>`) and on
every `v*` tag (tags `1.2.0` and `1.2`). It can also be run by hand for another branch (Actions → CI →
Run workflow → "Also build and push the image"). Until the work is merged to `main` or tagged, no image
exists and the server keeps building locally.

One-time setup for a private package: create a GitHub personal access token (classic) with only the
`read:packages` scope and log in on the server as root, which stores it in `/root/.docker/config.json`:

```bash
echo '<token>' | docker login ghcr.io -u <github-username> --password-stdin
```

Pin a version tag in production. `:main` moves with every merge.

## Procedure
1. Read the release notes for migration or configuration changes (`apps/api/migrations/`, `deploy/.env.example` diff).
2. `cd /opt/securesend && git fetch && git checkout <tag>` (or `git pull` on the branch you deploy from).
   The checkout always supplies `docker-compose.yml`, the Caddyfile and `clamd.conf`, in both modes.
3. Pull mode only: set `SECURESEND_IMAGE` in `deploy/.env` to the matching image tag.
4. `sudo deploy/upgrade.sh`. It:
   * adds any new settings to `deploy/.env` (for example generates `MONITOR_TOKEN`);
   * tags the image the api is running now as `securesend:rollback-<stamp>` and records it in `deploy/.last-image`;
   * runs `deploy/backup.sh` (the upgrade stops if the backup fails; `SKIP_BACKUP=1` overrides);
   * builds or pulls the application image and pulls the pinned third-party images;
   * waits for PostgreSQL to be healthy, stops api and worker, applies migrations
     (`node dist/cli.js migrate`, advisory-locked and idempotent), starts everything and waits for the api health check;
   * reports the scanner's state without failing on it: after a restart clamd needs several minutes to load
     its signatures, and uploads simply wait in quarantine until it is ready;
   * keeps the three most recent rollback images.
5. Check `sudo deploy/monitor-check.sh`, System health, and send a test transfer.
6. If `deploy/systemd/` changed in the release, re-run `sudo deploy/install-timers.sh`.

Migrations are forward-only SQL files applied in order and recorded in `schema_migrations`.

## Rollback
* Application only (no migration in the release): `sudo deploy/rollback.sh` pins the previous image as
  `SECURESEND_IMAGE` in `deploy/.env` and restarts api and worker. Pass an image to choose another:
  `sudo deploy/rollback.sh ghcr.io/snelly101/lfs-upload:1.1.0`. The next `deploy/upgrade.sh` removes a
  local `securesend:rollback-*` pin by itself; a registry tag stays until you change it.
* If `deploy/` files changed in the release, also `git checkout` the previous commit (printed by the
  script from `deploy/.last-commit`).
* Release included a migration: stop api/worker, restore the pre-upgrade database backup
  (`deploy/restore.sh <file>`), then `deploy/rollback.sh`. Content on disk is unaffected by a database
  rollback; the worker's reconcile pass removes any content the restored database no longer references.

## Updating base images and dependencies
* Images are pinned in `deploy/docker-compose.yml` and `deploy/Dockerfile` (`caddy`, `postgres`,
  `clamav/clamav`, `node`). Bump the tag, review the upstream changelog, then run the upgrade procedure.
  PostgreSQL **major** upgrades need `pg_upgrade` or dump/restore; the compose file pins a major version for that reason.
* Node dependencies are pinned exactly (`.npmrc` `save-exact=true`, `pnpm-lock.yaml`). Dependabot
  (`.github/dependabot.yml`) opens grouped pull requests weekly for npm and monthly for the Docker
  images and GitHub Actions; each must pass CI. CI also runs `pnpm audit --prod` and shows the result
  without failing the build, so read it when you review an update.
* Host packages: Ubuntu security updates install themselves (`deploy/harden-host.sh`). Docker Engine is
  not auto-upgraded; run `apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io` in a
  maintenance window.
* ClamAV signatures update themselves (freshclam) and do not need an application upgrade.
