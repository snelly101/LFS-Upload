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
| Backup | last recorded restore drill | older than 90 days → run a drill |

Liveness `GET /healthz` (process up) versus readiness `GET /readyz` (database reachable, migrations
present). Both are unauthenticated and reveal nothing else.

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
docker compose -f deploy/docker-compose.yml exec clamav clamdscan --version   # "ClamAV 1.4.x/<sig version>/<date>"
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
| Daily (automatic) | backup (`deploy/backup.sh` via cron), audit purge job, signature updates |
| Weekly | review open alerts, failed outbox messages, dead jobs |
| Monthly | `pnpm audit`, image tag updates (docs/UPGRADE.md), review user list and roles |
| Quarterly | restore drill, review retention settings and privacy decisions |
