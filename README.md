# Together Housing Secure File Send

Self-hosted, single-organisation large-file dispatch for Together Housing. Staff upload files,
address them to named recipients, and send invitations; recipients prove control of their mailbox
with a one-time code before downloading. Content lives only on your server, is quarantined and
scanned before release, and is verifiably deleted at expiry.

The product name, organisation name, logo and accent colour are configurable in Administration → Branding; the defaults are "Together Housing Secure File Send" / "Together Housing".

| | |
|---|---|
| Stack | Node 22 · TypeScript · Fastify 5 · PostgreSQL 16 · tus resumable uploads · ClamAV · React 19 · Caddy |
| Deploy | `deploy/docker-compose.yml` (api, worker, db, clamav, caddy) – see `docs/INSTALL.md` |
| Develop | `docs/DEVELOPMENT.md` |
| Security | `docs/THREAT-MODEL.md`, `docs/ASVS-MAP.md`, `docs/PRIVACY-DECISIONS.md` |
| Go live | `docs/GO-LIVE.md` (ordered checklist from LAN test to public service) |
| Operate | `docs/OPERATIONS.md`, `docs/RUNBOOK-BACKUP-RESTORE.md`, `docs/UPGRADE.md`, `docs/EMERGENCY-ACCESS.md` |
| Identity | `docs/ENTRA-SETUP.md` (Microsoft Entra ID / OIDC) |
| Evidence | `docs/CHECKLIST.md` (requirement → implementation), `docs/TEST-EVIDENCE.md`, `docs/screenshots/` |

## Layout

```
apps/api        Fastify API, worker, CLI, SQL migrations, integration tests (vitest)
apps/web        React UI (staff shell + recipient pages)
packages/shared Policy schemas, API types, formatting helpers
tests/e2e       Playwright browser journeys
deploy/         Compose, Dockerfile, Caddyfile, clamd.conf; install, upgrade, backup, restore-check,
                host hardening and monitoring scripts; systemd timers
.github/        CI (typecheck, build, integration tests, image publishing) and Dependabot
docs/           Architecture, runbooks, threat model, evidence
```

## Quick start (development)

```
pnpm install
cp deploy/.env.example apps/api/.env   # edit DATABASE_URL, PUBLIC_URL, SERVER_SECRET_KEY, CONTENT_ROOT, CLAMD_*
pnpm --filter @securesend/shared run build
pnpm db:migrate && pnpm db:seed          # fictitious dev accounts, see docs/DEVELOPMENT.md
pnpm dev:api & pnpm dev:worker & pnpm dev:web
```

Tests: `pnpm test` (integration, needs PostgreSQL + clamd) · `pnpm test:e2e` (browser).

## Operations at a glance

```
sudo deploy/install.sh you@example.com   # first install (docs/INSTALL.md)
sudo deploy/harden-host.sh               # security updates, log limits, volume and clock checks
sudo deploy/install-timers.sh            # nightly encrypted backup + monthly restore check
sudo deploy/monitor-check.sh             # one-line health summary, exit 0/1/2 for an RMM
sudo deploy/upgrade.sh                   # backup, build or pull, migrate, restart (docs/UPGRADE.md)
sudo deploy/rollback.sh                  # back to the previous image
```

Every push runs `.github/workflows/ci.yml`; pushes to `main` and `v*` tags publish
`ghcr.io/snelly101/lfs-upload` so the server can pull a tested image instead of building.
