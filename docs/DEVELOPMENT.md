# Development

## Prerequisites
Node 22, pnpm 10 (`corepack enable`), PostgreSQL 16, ClamAV (`clamd`) for real scan tests, Chromium via
Playwright for browser tests.

```bash
pnpm install
sudo -u postgres psql -c "CREATE USER snelson WITH PASSWORD 'snelson_dev';" \
  -c "CREATE DATABASE snelson OWNER snelson;" -c "CREATE DATABASE snelson_test OWNER snelson;"
cp deploy/.env.example apps/api/.env   # then set NODE_ENV=development, PUBLIC_URL=http://localhost:3000,
                                       # DATABASE_URL=postgres://snelson:snelson_dev@127.0.0.1:5432/snelson,
                                       # SERVER_SECRET_KEY=$(openssl rand -base64 48), CONTENT_ROOT=$PWD/var/content,
                                       # MAIL_TRANSPORT=file, MAIL_FILE_DIR=$PWD/var/mail, CLAMD_MAX_STREAM_BYTES=104857600
pnpm --filter @snelson/shared build
pnpm db:migrate
pnpm bootstrap-admin admin@dev.snelson.invalid --password 'correct-horse-battery-staple-2026'
pnpm db:seed            # optional fictitious accounts (below)
scripts/dev-api.sh start   # API on :3000 (background, logs in /tmp/api.log)
scripts/dev-api.sh worker  # worker (logs in /tmp/worker.log)
pnpm dev:web               # Vite dev server on :5173 proxying /api to :3000
```

Emails are written as `.eml` files to `var/mail/` (`MAIL_TRANSPORT=file`); they never reach a real inbox.
With Compose, `docker compose --profile dev up` adds Mailpit at http://127.0.0.1:8025.

## Seed accounts (development only)
All use password `correct-horse-battery-staple-2026` and the TOTP secret printed by `pnpm db:seed`
(`JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP`): `admin@dev.snelson.invalid` (admin), `alex.sender@dev.snelson.invalid`
(sender), `audrey.audit@dev.snelson.invalid` (auditor). `seed` refuses to run when `NODE_ENV=production`.

## Local clamd with a test signature only
Signature downloads may be blocked in a sandbox. clamd will start with a tiny custom database that only
detects the EICAR test string, which is enough to exercise the INSTREAM protocol, FOUND/OK handling and
size-limit behaviour:

```bash
mkdir -p /tmp/clamtest/db /tmp/clamtest/run
printf 'Eicar-Test-Signature:0:*:58354f2150254041505b345c505a58353428505e2937434329377d2445494341522d5354414e444152442d414e544956495255532d544553542d46494c452124482b482a\n' > /tmp/clamtest/db/eicar.ndb
cat > /tmp/clamtest/clamd.conf <<'C'
LogFile /tmp/clamtest/clamd.log
PidFile /tmp/clamtest/run/clamd.pid
DatabaseDirectory /tmp/clamtest/db
TCPSocket 3310
TCPAddr 127.0.0.1
StreamMaxLength 100M
MaxFileSize 100M
MaxScanSize 100M
AlertExceedsMax yes
C
clamd --config-file=/tmp/clamtest/clamd.conf
```
Set `CLAMD_MAX_STREAM_BYTES=104857600` to match. Production uses the full signature set via freshclam.
`FAKE_SCANNER=1` (non-production only) swaps in an in-memory scanner for unit tests of outcome handling.

## Tests
```bash
pnpm test        # API integration tests (vitest) against snelson_test; needs clamd for scan tests
pnpm test:e2e    # Playwright browser tests against a built UI
```
See docs/TEST-EVIDENCE.md for what is covered and the recorded results.

## Layout
`apps/api` Fastify API + worker + CLI; `apps/web` React/Vite UI; `packages/shared` policy schemas and
view types; `deploy/` Compose and runbooks; `docs/` design and operations; `tests/e2e` browser tests.
