# Operations guide

## System health page (Administration → System health)
| Panel | Meaning | Act when |
|---|---|---|
| Disk | `statfs` of the content root: total/free/available, bytes used by live content, bytes reserved by in-flight uploads | available < warn % (default 15) → plan capacity; < critical % (5) → new uploads are refused |
| Scanner | clamd `VERSION` reply (includes signature date) and the configured `CLAMD_MAX_STREAM_BYTES` | not OK → uploads stay quarantined; check the clamav container and freshclam logs |
| Scans | files waiting/scanning; scan errors in 24 h | backlog growing → scanner too slow or down |
| Uploads | active uploads; abandoned in 24 h | many abandoned → client network issues or quota refusals |
| Deletion | pending/in-progress, failed, oldest requested, completed 24 h, average seconds from request to verified completion over 7 days; target minutes (default 5) | failed > 0 or oldest older than the target → alert is raised; inspect the worker log and the volume |
| Jobs | queue counts by kind/state including `dead` | dead jobs → an alert with the payload; fix the cause and re-queue by resolving the alert and letting the sweep re-create it |
| Workers | heartbeats (every 10 s); "alive" if seen within 60 s | none alive → nothing is scanned, sent or deleted (access denial still works) |
| SMTP | queued/failed outbox messages, sent in 24 h, transport | failures → SMTP test from Notifications settings |
| Active streams | downloads currently being served by this API process | informational |
| Audit chain | hash-chain verification over the last 5 000 rows | not OK → treat as a security incident |
| Backup verification | when a restore was last proven and the note recorded with it (written by the monthly `deploy/restore-check.sh`, or by hand after a drill) | older than about 5 weeks → the restore-check timer is not running; older than 90 days → run a full drill |

Liveness `GET /healthz` (process up) versus readiness `GET /readyz` (database reachable, migrations
present). Both are unauthenticated and reveal nothing else. `GET /statusz` is the monitoring summary:
it needs `Authorization: Bearer <MONITOR_TOKEN>` (404 when no token is configured) and returns only
levels, `{ "ok": true, "checks": { "database", "worker", "scanner", "storage", "deletion", "email" } }`
with each check `ok`, `warn` or `fail`; HTTP 200 when nothing fails, 503 otherwise.

## Monitoring from NinjaOne (or any RMM)
`deploy/monitor-check.sh` is a single command that prints a one-line summary and exits `0` (ok), `1`
(warning) or `2` (failure):

```
SECURESEND OK | services=ok app=ok volumes=ok backup=ok tls=ok system-disk=ok
```

Lines after the first name each check that is not ok and what to do. It checks:

| Check | Fails when | Warns when |
|---|---|---|
| `services` | a compose service (caddy, api, worker, db, clamav) is not running or is unhealthy | one is still starting |
| `app` | `GET /statusz` reports a failed check or does not answer | a check is at `warn`, or `MONITOR_TOKEN` is missing or not loaded |
| `proxy` | the application answers inside its container but not through Caddy | — |
| `volumes` | `/srv/securesend/content` or `/srv/securesend/db` is not mounted from a LUKS device | — |
| `backup` | no backup exists or the newest is older than `BACKUP_MAX_AGE_HOURS` (36) | the newest backup is not encrypted |
| `securesend-backup` / `securesend-restore-check` | the unit's last run failed | the backup timer is not enabled (`backup-timer`) |
| `tls` (only `TLS_MODE=acme`) | no certificate is served, or it expires within 3 days | it expires within 14 days. With `TLS_MODE=internal` the check always warns: that is the test certificate |
| `system-disk` | the system disk is 95% full | 85% full |
| `reboot` | — | `/var/run/reboot-required` exists |

Schedule it every 5 minutes as a script-result monitor that runs as root and alerts on a non-zero exit
code; treat exit `2` as critical and exit `1` as a ticket. The script prints no secrets.

## Things that run by themselves
| What | How | Check it with |
|---|---|---|
| Nightly database backup, retention, optional off-host copy | `securesend-backup.timer` → `deploy/backup.sh` | `systemctl list-timers 'securesend-*'`, `journalctl -u securesend-backup.service` |
| Monthly restore check, recorded in System health | `securesend-restore-check.timer` → `deploy/restore-check.sh` | `journalctl -u securesend-restore-check.service` |
| Ubuntu security updates (no automatic reboot unless you enabled the 03:30 window) | `unattended-upgrades`, configured by `deploy/harden-host.sh` | `/var/log/unattended-upgrades/unattended-upgrades.log` |
| Expiry sweep, deletion, reconciliation, audit purge, disk and scanner checks | the worker's own schedule | System health |
| Virus signature updates | freshclam inside the `clamav` container | Scanner panel shows the signature date |
| Certificate renewal (`TLS_MODE=acme`) | Caddy | `tls` check in `monitor-check.sh` |

Not automatic, on purpose: reboots after kernel updates, Docker Engine upgrades and application upgrades
(docs/UPGRADE.md). Each interrupts live transfers and belongs in a maintenance window.

## Alerts
Operational alerts are rows in `operational_alerts`; each open alert creates one in-app notification per
administrator and one email per address in Notifications → admin alert emails (or every admin if empty).
Kinds: `deletion_failed`, `deletion_backlog`, `disk`, `scanner`, `smtp`, `job_dead`. Alerts self-resolve when
the condition clears (disk, scanner, SMTP, backlog, deletion success); `job_dead` must be resolved manually.

## Deletion target and how it is measured
`deletion_requested_at` is set when expiry or revocation makes content eligible; a `delete_transfer` job
is queued at priority 10 (ahead of everything except `delete-now` at 5). The worker unlinks every candidate
path (tus partial + sidecar, quarantine, released, tmp) and then `lstat`s each one; only when all are gone
is `deletion_completed_at` set and `deleted` shown. Average and oldest values are on the health page; the
disk check job raises `deletion_backlog` when anything is older than the target. If the server is off,
deletion happens after restart: the worker's first pass runs overdue deletions before other jobs.

## Scanner freshness
```bash
docker compose -f deploy/docker-compose.yml exec clamav clamdscan --version   # "ClamAV 1.5.x/<sig version>/<date>"
docker compose -f deploy/docker-compose.yml logs clamav | grep -i freshclam | tail
```
Signatures older than 48 hours mean freshclam cannot reach its mirror. The health page shows the same
VERSION string.

## Sizing
* **Content volume**: ≥ (expected concurrent active transfers × average transfer size) + headroom for
  in-flight uploads; for the configured maxima: `max concurrent transfers × 250 GiB × 1.2`. Uploads are
  refused when `available − reserved − new file < critical %` of the volume.
* **CPU**: clamd scanning is single-threaded per file and roughly 100–300 MB/s on a modern core; a
  100 GiB file (if `StreamMaxLength` were raised) takes 5–15 minutes. Downloads and uploads are I/O bound;
  one API process streams multiple GB/s on local NVMe.
* **Memory**: API and worker stream in 1 MiB chunks; memory does not grow with file size (see
  docs/TEST-EVIDENCE.md for the measured profile). ClamAV needs ~3 GiB resident.
* **Network**: transfer time = size / bandwidth; a 100 GiB upload on a 1 Gbit/s link takes about 15 minutes
  of sustained throughput, 2.5 hours on 100 Mbit/s. tus resumes after interruptions.
* **Tested load profile**: see docs/TEST-EVIDENCE.md for the sizes and concurrency actually exercised in
  this repository's tests. The 100 GiB / 250 GiB figures are configuration ceilings, not tested throughput claims.

## Routine tasks
| Frequency | Task |
|---|---|
| Every 5 minutes (automatic) | `deploy/monitor-check.sh` from the RMM |
| Daily (automatic) | database backup (`securesend-backup.timer`), security updates, audit purge job, signature updates |
| Weekly | review open alerts, failed outbox messages, dead jobs; act on Dependabot pull requests |
| Monthly (automatic) | restore check (`securesend-restore-check.timer`) |
| Monthly | maintenance window: `apt-get dist-upgrade` if needed, reboot if `/var/run/reboot-required` exists, application upgrade (docs/UPGRADE.md), review user list and roles |
| Quarterly | full restore drill on a second host (docs/RUNBOOK-BACKUP-RESTORE.md), off-host decryption test of a backup, review retention settings and privacy decisions |
