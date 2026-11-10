# Backup and restore runbook

## What is backed up, and what is deliberately not
| Data | Backed up? | Where | Why |
|---|---|---|---|
| PostgreSQL database (users, transfers metadata, grants, audit chain, settings, encrypted secrets, jobs) | Yes, nightly | `deploy/backup.sh` → `BACKUP_DIR` (default `/var/backups/securesend`), age-encrypted when `BACKUP_AGE_RECIPIENT` is set | Required to recover the service and audit history |
| `deploy/.env` (`SERVER_SECRET_KEY`, DB password, monitor token) | Yes, with each database backup (`securesend-env-<stamp>[.age]`) | same directory | Without `SERVER_SECRET_KEY` a restored DB cannot decrypt TOTP seeds, SMTP and OIDC secrets. Also keep a copy in your secrets vault |
| LUKS key files `/etc/securesend/luks/*.key` | **No, on purpose** | escrow them in your secrets vault | A backup that carries the keys beside the data they protect is not encryption. They are only needed to unlock the volumes on this host |
| Content volume `/srv/securesend/content` | **No** | — | File bytes must not outlive expiry. A content backup would silently defeat deletion. If you ever add one, retention must be shorter than the shortest expiry and keys must be destroyable (docs/THREAT-MODEL.md) |
| Caddy certificates (`caddy_data` volume) | Optional | — | Re-issued automatically if lost |
| ClamAV signatures | No | — | Re-downloaded |

Consequence, stated plainly: after a disaster that destroys the content volume, in-flight transfers
cannot be recovered. Senders must re-send. The audit trail still shows what happened.

## Backup
`deploy/backup.sh` is run every night at about 02:15 by `securesend-backup.timer`. Install the timers once:

```bash
sudo /opt/securesend/deploy/install-timers.sh
systemctl list-timers 'securesend-*'
```

What a run does, in order:
1. `pg_dump -Fc -Z 6` through the `db` container into `BACKUP_DIR` (files are created `0600`, the directory `0700`).
2. Reads the archive's table of contents back and refuses to continue unless it lists data for
   `schema_migrations`, `users` and `audit_events`.
3. Encrypts the dump and a copy of `deploy/.env` to `BACKUP_AGE_RECIPIENT` with `age` and removes the
   plain file. **Without `BACKUP_AGE_RECIPIENT` the dump stays unencrypted on the system disk and every
   run prints a warning**; `deploy/monitor-check.sh` reports it as a warning too.
4. Retention: keeps the newest backup of each of the last `BACKUP_KEEP_DAILY` (14) days, then the newest of
   each of the `BACKUP_KEEP_WEEKLY` (8) ISO weeks before that, and removes the rest.
5. If `BACKUP_RSYNC_TARGET` is set, copies the encrypted files there with rsync over SSH. Unencrypted
   backups are never copied off the host; the run fails instead.
6. Writes `LAST_SUCCESS`. Any failure exits non-zero, which marks the systemd unit failed and is reported
   by `deploy/monitor-check.sh`.

### Encryption keys
Create the key pair on an administrator workstation, not on the server:

```bash
age-keygen -o securesend-backup.key      # prints "Public key: age1..."
```

Put the public key in `BACKUP_AGE_RECIPIENT` in `deploy/.env`. Store `securesend-backup.key` in your
secrets vault. You choose whether a copy of the private key also lives on the server
(`BACKUP_AGE_IDENTITY_FILE`, mode `0400`, root):

| Private key on the server? | Monthly restore check | What encryption protects |
|---|---|---|
| Yes | Decrypts and restores the real newest backup file | Off-host copies and casual reads. Not a compromise of this host (root there can read the live database anyway) |
| No | Proves the dump/restore pipeline with a fresh dump and checks the newest file's age header only; the recorded note says "pipeline only" | Also the copies on this host's system disk. You must test decryption off-host yourself, at least quarterly |

The dump contains personal data (names, email addresses, filenames) and the chained audit log: treat it
as confidential and apply the same retention decisions as the live data (docs/PRIVACY-DECISIONS.md).

Note on cryptographic erasure: secrets in the dump are wrapped with `SERVER_SECRET_KEY`. Keeping old
dumps plus the current key means old TOTP seeds and SMTP/OIDC secrets remain recoverable; rotate the
key (re-enrol MFA, re-enter secrets) if a dump is suspected lost.

## Automated restore check
`deploy/restore-check.sh` runs on the first of each month (`securesend-restore-check.timer`). It starts a
throwaway PostgreSQL container from the same pinned image as production, on an isolated Docker network
with RAM-backed storage, restores the newest backup into it, checks that `schema_migrations`, `users` and
`audit_events` are present and readable, and removes the container. The live database is not touched.
On success it records the result in the application (`node dist/cli.js record-backup-verification`), which
is what Administration → System health → Backup verification shows.

Run it by hand at any time:

```bash
sudo systemctl start securesend-restore-check.service
journalctl -u securesend-restore-check.service -n 30 --no-pager
```

This check proves the backup can be read and loaded. It does not replace the full restore drill below,
which also proves you can rebuild a host.

## Restore
1. Provision the host as in docs/INSTALL.md (encrypted volumes). Restore `deploy/.env` from the matching
   `securesend-env-<stamp>[.age]` file (`age -d -i securesend-backup.key ... > deploy/.env; chmod 600 deploy/.env`)
   so the original `SERVER_SECRET_KEY` is in place.
2. `docker compose -f deploy/docker-compose.yml up -d db`
3. `sudo deploy/restore.sh /path/to/securesend-db-<stamp>.dump[.age]` (for an encrypted file set
   `BACKUP_AGE_IDENTITY_FILE=/path/to/securesend-backup.key`). It asks you to type `RESTORE`, streams the
   dump into a scratch database without writing a decrypted copy to disk, swaps names (the previous database is kept as `securesend_old_<epoch>` until you drop it),
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
   worker alive. Send a test transfer. Record the drill in System health → "Record a backup/restore
   verification".

## Restore drill
Perform a restore to a staging host at least quarterly. The brief's requirement that "restored database
metadata cannot resurrect expired content access" is covered by an automated test
(`apps/api/src/test/10-restore-reconcile.test.ts`, see docs/TEST-EVIDENCE.md) and should also be part of the drill: restore a
dump taken while a transfer was active, confirm the link now reports "expired" and no file is served.
