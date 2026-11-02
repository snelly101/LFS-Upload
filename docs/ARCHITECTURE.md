# Together Housing Secure File Send – architecture

Product name: **Together Housing Secure File Send** (configurable in Branding settings). Single-organisation,
self-hosted large-file dispatch application for Together Housing.

## 1. Stack and tradeoffs

| Layer | Choice | Why / tradeoff |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript 5.9 | One language across API, worker and UI. Streams are first-class, which the data path depends on. |
| HTTP/API | Fastify 5 | Mature, fast, schema-validated routing, raw-socket access for streaming. Upload bytes are handed to the tus handler on the raw Node request so no framework body parser touches them. |
| Resumable upload | tus protocol via `@tus/server` + `@tus/file-store` | Maintained reference implementation of a public protocol. Client (`tus-js-client`) resumes after refresh/network loss. Our hooks enforce ownership, limits, naming and quota. |
| Database | PostgreSQL 16 | Transactions, row locks and advisory locks give us atomic grant/allowance/state transitions. Also hosts the job queue and outbox so state changes and job enqueueing commit together. |
| Jobs | Small in-house Postgres queue (`jobs` table, `FOR UPDATE SKIP LOCKED`) | ~200 lines we fully understand. Durable, idempotent keys, bounded retries with backoff, dead-letter state, transactional enqueue in the same commit as the state change. Chosen over pg-boss to keep the outbox transactional without a second abstraction. Tradeoff: no dashboard; health is exposed through System health instead. |
| Scanner | ClamAV `clamd` over its INSTREAM socket protocol, isolated container, no network | Local, free, maintained. We configure `StreamMaxLength`, `MaxFileSize`, `MaxScanSize`, `MaxRecursion`, `MaxFiles` explicitly and treat *any* non-`OK` outcome (FOUND, ERROR, size exceeded, timeout, unavailable) as "not clean". Files above the scanner limit are reported honestly as *not scanned* and blocked by default. |
| Email | SMTP via nodemailer; outbox + worker | Standard. Dev/test uses Mailpit (Compose) or an in-process SMTP capture server (tests). |
| UI | React 19 + Vite 7, hand-written CSS with design tokens | No UI kit, so the "dispatch desk" look is original. TanStack Query for server state. |
| Reverse proxy / TLS | Caddy 2 (nginx guidance also documented) | Automatic certificates, simple config, request body is streamed (no buffering to temp files). |
| Encryption at rest | LUKS volume for `/srv/snelson/content` and DB volume, documented prerequisites and operator checks | Protects powered-off storage; does **not** isolate content from a compromised running host. App-level content encryption is deliberately not claimed. |

Not used: Kubernetes, cloud object storage, hosted analytics, hosted error tracking, third-party scripts.

## 2. Processes

```
 browser ──TLS──> caddy ──> api (Fastify)  ──┐
                                             ├── PostgreSQL (app schema + jobs + audit)
                 worker (same image, `worker` entry) ┘
                       │
                       └── clamd (INSTREAM over TCP on the private network)
 api, worker ── SMTP ──> organisation mail relay (explicit external dependency)
 api ── OIDC ──> Microsoft Entra ID / other OIDC provider (explicit external dependency)
```

Storage layout (single encrypted volume so renames are atomic):

```
/srv/snelson/content/
  incoming/    tus partial uploads (file <uploadId>, metadata <uploadId>.json)
  quarantine/  finalised but not yet released (<fileId>)
  released/    scan passed, downloadable (<fileId>)
  tmp/         scanner/zip scratch (bounded, swept)
```

A file's bytes exist in exactly one of these directories at a time; moves are `rename(2)`.
Deletion verifies all four locations plus the tus metadata file before marking `deleted`.

## 3. Data model (summary)

Core tables (see `apps/api/migrations/*.sql` for the authoritative definitions):

* `users` – immutable `id`, `email`, `display_name`, `role` (sender|auditor|admin), `auth_kind` (local|sso), `status` (invited|active|disabled), `mfa_enforced_at`.
* `local_credentials` – argon2id password hash, `email_verified_at`.
* `mfa_totp`, `mfa_webauthn_credentials`, `mfa_recovery_codes` – factors; recovery codes stored hashed, single use.
* `sso_identities` – (`issuer`, `subject`) → user; no email-based linking.
* `sessions` – server-side; cookie holds a random id, table stores its SHA-256, `mfa_completed_at`, `last_seen_at`, `absolute_expires_at`, `revoked_at`, `auth_level` (password_only|full). Admin actions requiring recent auth check `last_strong_auth_at`.
* `settings` – single row of JSON sections, versioned; secrets stored encrypted with a server key and never returned.
* `policy_versions` – immutable snapshot of transfer policy each time an admin saves; transfers reference the version in force when created and the *effective* policy is recorded on the transfer.
* `transfers` – `status` (draft|uploading|scanning|ready|sending|active|expired|revoked), `sent_at`, `expires_at`, `verification_mode` (required|bearer), `download_limit_per_recipient`, `deletion_status` (none|pending|in_progress|deleted|failed) with `deletion_requested_at/started_at/completed_at/attempts/last_error_redacted`, `effective_policy` JSON, `policy_version_id`.
* `transfer_files` – random `id` (internal name), `display_name` (sanitised), `size_bytes`, `upload_status` (pending|uploading|finalised|abandoned), `scan_status` (pending|scanning|clean|infected|error|unavailable|oversized|skipped|timeout), `storage_state` (incoming|quarantine|released|deleted), `sha256`.
* `recipient_grants` – per recipient: `email`, `token_hash` (SHA-256 of 32-byte random token), `status` (pending|invited|revoked), `downloads_used`, `first_verified_at`, `all_files_completed_at`.
* `recipient_verifications` – OTP challenges: `code_hash` (HMAC-SHA-256 with server pepper), `expires_at`, `attempts`, `consumed_at`, `superseded_at`.
* `recipient_sessions` – scoped sessions after verification: `grant_id`, `token_hash`, `expires_at`, `revoked_at`, `verified_email`.
* `download_attempts` – one per (grant, file, session) download; `ranges` coverage (int8range[] merged), `bytes_served`, `completed_at`, `allowance_consumed`.
* `jobs` – queue: `kind`, `payload`, `idempotency_key` (unique), `run_at`, `attempts`, `max_attempts`, `state` (queued|running|done|dead), `last_error`.
* `outbox_messages` – notifications awaiting delivery (`kind`, `to`, `template`, `data`, `dedupe_key`, `status`, `attempts`, `provider_response`).
* `in_app_notifications` – per user.
* `audit_events` – append-only (INSERT-only DB role + trigger blocking UPDATE/DELETE): `occurred_at`, `event_type`, `correlation_id`, actor (`actor_user_id`, `actor_email_at_event`, `actor_kind` user|recipient|system|anonymous), `transfer_id`, `file_id`, `grant_id`, `outcome`, `details` (redacted JSON), `ip_prefix`, `user_agent_hash`, `prev_hash`, `hash` (chained SHA-256 for integrity verification).

## 4. State machines

**Transfer**: `draft → uploading → scanning → ready → sending → active → (expired | revoked)`; `deletion_status` runs independently: `none → pending → in_progress → (deleted | failed→pending…)`. Access is denied when `status ∉ {active}` OR `now ≥ expires_at` OR `deletion_status ≠ none`. Expiry is checked on every request with server time; the sweep job only *records* the transition and triggers deletion.

**File**: upload `pending → uploading → finalised | abandoned`; scan `pending → scanning → clean | infected | error | unavailable | oversized | timeout`; storage `incoming → quarantine → released → deleted`. Release requires `scan = clean`.

**Grant**: `pending → invited → revoked`; verification required unless transfer `verification_mode = bearer`.

**OTP**: `issued → (consumed | expired | locked | superseded)`.

**Recipient session**: `active → (expired | revoked)`; revoked when grant/transfer revoked, expiry reached, or policy tightened.

**Download attempt**: `started → (completed | interrupted)`; completion = merged ranges cover `[0, size)`.

**Notification**: `queued → sent | failed | suppressed` (suppressed when the transfer is no longer active at send time).

## 5. Enforcement points

* Every API route resolves the acting principal and checks object ownership in SQL (`WHERE sender_id = $user`) – no client-side trust.
* tus hooks: `onIncomingRequest` (ownership of the upload id), `onUploadCreate` (file record exists, belongs to the user, declared size within policy, quota reserved), `maxSize` (policy), `namingFunction` (our random id), `onUploadFinish` (size equals declared, move to quarantine, enqueue scan).
* Download: `GET /r/:token/files/:fileId` requires a valid recipient session bound to the grant; each request rechecks transfer status, expiry, revocation, deletion state, and scan state; allowance reserved atomically with `UPDATE … WHERE downloads_used < limit RETURNING`.
* Live stop: every active stream registers in the process's `ActiveStreams` registry. A Postgres `LISTEN snelson_access_changed` plus a 2-second re-check loop destroys sockets of streams whose grant/transfer became invalid. Target bound: 5 s. Tested.
* Deletion: job per transfer + hourly reconciliation sweep that scans the storage directories and the DB for anything overdue; deletion is verified by `stat` on every managed path before `deleted` is recorded.

## 6. Threat model (summary – full version in THREAT-MODEL.md)

| Threat | Controls |
|---|---|
| Forwarded invitation link | Per-recipient token; email OTP sent only to the original address; link fetch alone does nothing; session bound to grant. |
| Account compromise (staff) | Mandatory MFA for local accounts; IdP Conditional Access for SSO; short sessions; step-up for security changes; security notices. |
| Malicious upload | Quarantine; clamd with explicit limits; nothing downloadable until clean; attachment disposition; no inline preview; no execution. |
| IDOR / enumeration | Random ids; ownership in every query; generic 404s; tests for cross-user access including tus endpoints. |
| Brute force | OTP: 5 attempts, 10 min, 60 s resend cooldown, per-grant/per-IP rate limits; login rate limits; constant-time compares. |
| Quota/disk exhaustion | Per-file/transfer/user quotas enforced during upload; disk reservation; abandoned upload sweep; low-disk alert. |
| Worker outage | Expiry enforced on request path; reconciliation on restart; overdue deletion prioritised and alerted. |
| Unsafe restore | Restored metadata cannot re-enable expired access (expiry is time-based, deletion flags persist); content volume excluded from backups. |
| Privileged operator | Audit chain hash + export; admins have no content access by default; documented single-host limits. |
| Leaked secrets | Hashed tokens/OTPs/sessions; secrets encrypted at rest, masked in UI, rotated via documented procedure. |

## 7. Assumptions

* Single Ubuntu host; downtime during upgrades is acceptable.
* Content volume is LUKS-encrypted and excluded from backups/snapshots (operator responsibility, with checks in System health).
* The organisation's SMTP relay and Entra tenant are available; their configuration is tested by the administrator using the built-in test tools.
* Displayed time zone defaults to Europe/London; all storage is UTC.
* Large-file targets (100 GiB file / 250 GiB transfer) are configuration ceilings validated against available disk; the tested profile is recorded in TEST-EVIDENCE.md.
