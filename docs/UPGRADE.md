# Upgrade and rollback

Single-host deployment: upgrades cause a short outage (typically under two minutes). In-flight uploads
resume automatically afterwards (tus); in-flight downloads must be restarted (individual files resume via
Range; ZIP downloads restart from the beginning).

## Procedure
1. Read the release notes for migration or configuration changes (`apps/api/migrations/`, `deploy/.env.example` diff).
2. `git fetch && git checkout <tag>`
3. `sudo deploy/upgrade.sh` — tags the current image as `snelson-send:rollback-<stamp>`, runs
   `deploy/backup.sh`, builds, stops api/worker, applies migrations (`node dist/cli.js migrate`, advisory-locked
   and idempotent), starts everything.
4. Check `docker compose ps`, `/readyz`, System health, and send a test transfer.

Migrations are forward-only SQL files applied in order and recorded in `schema_migrations`.

## Rollback
* Application only (no migration in the release): `sudo deploy/rollback.sh` re-tags the previous image and restarts api/worker.
* Release included a migration: stop api/worker, restore the pre-upgrade database backup
  (`deploy/restore.sh <file>`), then `deploy/rollback.sh`. Content on disk is unaffected by a database
  rollback; the worker's reconcile pass removes any content the restored database no longer references.

## Updating base images and dependencies
* Images are pinned in `deploy/docker-compose.yml` and `deploy/Dockerfile` (`caddy`, `postgres`,
  `clamav/clamav`, `node`). Bump the tag, review the upstream changelog, then run the upgrade procedure.
  PostgreSQL **major** upgrades need `pg_upgrade` or dump/restore; the compose file pins a major version for that reason.
* Node dependencies are pinned exactly (`.npmrc` `save-exact=true`, `pnpm-lock.yaml`). Run `pnpm audit`
  and `pnpm outdated` monthly; dependency scanning should run in CI on every change.
* ClamAV signatures update themselves (freshclam) and do not need an application upgrade.
