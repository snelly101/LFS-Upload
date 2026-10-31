# Snelson Send

Self-hosted, single-organisation large-file dispatch for Snelsonserver Ltd. Staff upload files,
address them to named recipients, and send invitations; recipients prove control of their mailbox
with a one-time code before downloading. Content lives only on your server, is quarantined and
scanned before release, and is verifiably deleted at expiry.

"Snelson Send" is a configurable working name (Administration → Branding).

| | |
|---|---|
| Stack | Node 22 · TypeScript · Fastify 5 · PostgreSQL 16 · tus resumable uploads · ClamAV · React 19 · Caddy |
| Deploy | `deploy/docker-compose.yml` (api, worker, db, clamav, caddy) – see `docs/INSTALL.md` |
| Develop | `docs/DEVELOPMENT.md` |
| Security | `docs/THREAT-MODEL.md`, `docs/ASVS-MAP.md`, `docs/PRIVACY-DECISIONS.md` |
| Operate | `docs/OPERATIONS.md`, `docs/RUNBOOK-BACKUP-RESTORE.md`, `docs/UPGRADE.md`, `docs/EMERGENCY-ACCESS.md` |
| Identity | `docs/ENTRA-SETUP.md` (Microsoft Entra ID / OIDC) |
| Evidence | `docs/CHECKLIST.md` (requirement → implementation), `docs/TEST-EVIDENCE.md`, `docs/screenshots/` |

## Layout

```
apps/api        Fastify API, worker, CLI, SQL migrations, integration tests (vitest)
apps/web        React UI (staff shell + recipient pages)
packages/shared Policy schemas, API types, formatting helpers
tests/e2e       Playwright browser journeys
deploy/         Compose, Dockerfile, Caddyfile, clamd.conf, install/backup/restore scripts
docs/           Architecture, runbooks, threat model, evidence
```

## Quick start (development)

```
pnpm install
cp deploy/.env.example apps/api/.env   # edit DATABASE_URL, PUBLIC_URL, SERVER_SECRET_KEY, CONTENT_ROOT, CLAMD_*
pnpm --filter @snelson/shared run build
pnpm db:migrate && pnpm db:seed          # fictitious dev accounts, see docs/DEVELOPMENT.md
pnpm dev:api & pnpm dev:worker & pnpm dev:web
```

Tests: `pnpm test` (integration, needs PostgreSQL + clamd) · `pnpm test:e2e` (browser).
