# Backup and restore runbook

## What is backed up, and what is deliberately not
| Data | Backed up? | Where | Why |
|---|---|---|---|
| PostgreSQL database (users, transfers metadata, grants, audit chain, settings, encrypted secrets, jobs) | Yes | `deploy/backup.sh` → `/srv/snelson/backups` (optionally age/gpg encrypted) | Required to recover the service and audit history |
| `deploy/.env` (`SERVER_SECRET_KEY`, DB password) | Yes, separately, in your secrets manager | — | Without `SERVER_SECRET_KEY` a restored DB cannot decrypt TOTP seeds, SMTP and OIDC secrets |
| Content volume `/srv/snelson/content` | **No** | — | File bytes must not outlive expiry. A content backup would silently defeat deletion. If you ever add one, retention must be shorter than the shortest expiry and keys must be destroyable (docs/THREAT-MODEL.md) |
| Caddy certificates (`caddy_data` volume) | Optional | — | Re-issued automatically if lost |
| ClamAV signatures | No | — | Re-downloaded |

Consequence, stated plainly: after a disaster that destroys the content volume, in-flight transfers
cannot be recovered. Senders must re-send. The audit trail still shows what happened.

## Backup
`deploy/backup.sh` runs `pg_dump -Fc` through the db container and keeps 30 days (`BACKUP_KEEP_DAYS`).
Set `BACKUP_AGE_RECIPIENT` or `BACKUP_GPG_RECIPIENT` to encrypt at rest; copy the files off-host. The
dump contains personal data (names, email addresses, filenames) and the chained audit log: treat it as
confidential and apply the same retention decisions as the live data (docs/PRIVACY-DECISIONS.md).

Schedule with cron, e.g. `17 2 * * * /opt/snelson-send/deploy/backup.sh`.

Note on cryptographic erasure: secrets in the dump are wrapped with `SERVER_SECRET_KEY`. Keeping old
dumps plus the current key means old TOTP seeds and SMTP/OIDC secrets remain recoverable; rotate the
key (re-enrol MFA, re-enter secrets) if a dump is suspected lost.

## Restore
1. Provision the host as in docs/INSTALL.md (encrypted volumes, same `deploy/.env` including the original
   `SERVER_SECRET_KEY`).
2. `docker compose -f deploy/docker-compose.yml up -d db`
3. `sudo deploy/restore.sh /path/to/snelson-db-<stamp>.dump[.age|.gpg]` — restores into a scratch
   database, swaps names (the previous database is kept as `snelson_old_<epoch>` until you drop it),
   applies any pending migrations and starts the stack.
4. Safety behaviour you can rely on after a restore from older metadata:
   * Access is evaluated against server time and the persisted `expires_at`, `status`,
     `deletion_status` on every request. A restored row for a transfer that has since expired is
     **still expired**; nothing becomes downloadable again.
   * Recipient sessions and verification codes are also time-bound and cannot outlive the transfer.
   * The worker's startup pass runs `expire_sweep` and queues deletion for anything overdue; the hourly
     `reconcile` removes content on disk that no live, unexpired row owns, and files whose bytes are
     missing are reported in System health (deletion pending/failed) for operator review.
5. Verify: Administration → System health → audit chain verifies; no deletion backlog; scanner and
   worker alive. Send a test transfer. Record the drill with "Backup verified".

## Restore drill
Perform a restore to a staging host at least quarterly. The brief's requirement that "restored database
metadata cannot resurrect expired content access" is covered by an automated test
(`apps/api/test/expiry.test.ts`, see docs/TEST-EVIDENCE.md) and should also be part of the drill: restore a
dump taken while a transfer was active, confirm the link now reports "expired" and no file is served.
