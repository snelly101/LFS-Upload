# Test evidence (integration suite)

Integration tests run against a real PostgreSQL 16 database (`securesend_test`), a real `clamd`
(ClamAV 1.5.4 with an EICAR-only signature set because this build environment cannot reach
`database.clamav.net`), real HTTP on an ephemeral port (so Range, streaming, tus hijack and
live stream termination are exercised for real), an in-memory mail sink (`MemoryMailer`) and an
injected `TestClock`. No test email can reach a real mailbox. Every test file resets the schema and
the content root.

## Commands

```bash
# one-off prerequisites in this environment
pg_ctlcluster 16 main start
clamd --config-file=/tmp/clamtest/clamd.conf        # EICAR-only test database, TCP 127.0.0.1:3310

# the suite (sequential, ~45 s)
pnpm --filter @securesend/api run test

# the opt-in large-file test (1 GiB default; LARGE_SIZE_BYTES overrides)
LARGE_TESTS=1 pnpm --filter @securesend/api run test -- src/test/13-large-bounded-memory.test.ts
LARGE_TESTS=1 LARGE_SIZE_BYTES=2147483648 pnpm --filter @securesend/api run test -- src/test/13-large-bounded-memory.test.ts
```

## Result (2026-10-31, `pnpm --filter @securesend/api run test`)

```
 ✓ src/test/08-live-stop.test.ts (2 tests) 6534ms
 ✓ src/test/02-mfa.test.ts (7 tests) 4497ms
 ✓ src/test/15-notifications.test.ts (7 tests) 2366ms
 ✓ src/test/07-expiry-revocation.test.ts (4 tests) 2701ms
 ✓ src/test/14-parallel-cap.test.ts (3 tests) 1952ms
 ✓ src/test/16-policy.test.ts (11 tests) 2005ms
 ✓ src/test/12-resume.test.ts (4 tests) 1794ms
 ✓ src/test/09-cleanup.test.ts (3 tests) 1502ms
 ✓ src/test/05-otp.test.ts (7 tests) 1267ms
 ✓ src/test/11-scans.test.ts (8 tests) 1290ms
 ✓ src/test/17-leakage.test.ts (7 tests) 1246ms
 ✓ src/test/11b-clamd.test.ts (9 tests) 1065ms
 ✓ src/test/10-restore-reconcile.test.ts (3 tests) 1037ms
 ✓ src/test/06-anonymous-visits.test.ts (3 tests) 734ms
 ✓ src/test/04-forwarded-link.test.ts (4 tests) 950ms
 ✓ src/test/01-isolation.test.ts (5 tests) 848ms
 ✓ src/test/18-units.test.ts (10 tests) 373ms
 ✓ src/test/03-sso-claims.test.ts (8 tests) 4ms
 ↓ src/test/13-large-bounded-memory.test.ts (1 test | 1 skipped)   # opt-in, see below

 Test Files  18 passed | 1 skipped (19)
      Tests  105 passed | 1 skipped (106)
   Duration  45.16s
```

The full suite was run three consecutive times with identical results after a flaky fake-clamd
helper was fixed (the helper, not the scanner client, mis-detected the end-of-stream marker).

## Mapping to the brief's section 12

| # | Requirement | Test file | Notes |
|---|---|---|---|
| 1 | Cross-sender isolation incl. tus upload sessions | `01-isolation` | list/get/patch/send/revoke/files/recipients/extend → 404; tus HEAD/PATCH/DELETE/create on another sender's id → 404 (indistinguishable from unknown ids); anonymous → 401; auditor → 403 |
| 2 | Local auth cannot reach uploader/admin actions without MFA | `02-mfa` | password-only session blocked (`mfa_required`) on transfers, admin, audit, notifications, tus; invite-accept and password reset never yield a privileged session; recovery codes single-use; TOTP replay rejected; step-up for admin changes |
| 3 | SSO rejects wrong tenant/issuer/audience/unapproved users | `03-sso-claims` | pure claim validation; `roleFromGroups` ignores token `roles` |
| 4 | Forwarded link grants nothing | `04-forwarded-link` | code only ever goes to the grant's address; cross-grant code and cross-grant session both 401; per-recipient revocation |
| 5 | OTP expiry/replay/attempts/resend/atomic consumption | `05-otp` | 10-minute TTL, replay 401, 5th wrong attempt locks (429) even for the right code, 60 s cooldown, resend supersedes, hourly cap, 4 parallel verifies → exactly 1 success; codes stored as HMAC only |
| 6 | Anonymous GET/HEAD/scanner visits are side-effect free | `06-anonymous-visits` | only `recipient.link_requested` (actor anonymous, outcome info) is recorded; no mail, no verified view, no allowance |
| 7 | Expired/revoked deny with workers stopped | `07-expiry-revocation` | clock moved past `expires_at` with the DB row still `active`: public state `expired`, view/file/range/HEAD/zip 401, no new codes; whole-transfer revoke; delete-now denies before the job runs; extension refused |
| 8 | Active downloads stop within the bound | `08-live-stop` | 200 MiB stream terminated **184 ms** after revoke and **634 ms** after clock-based expiry (bound: 5000 ms); `download.interrupted` audited with reason `access_revoked` |
| 9 | Cleanup removes every copy; failures retry and alert | `09-cleanup` | released/quarantine/incoming/`.json`/tmp all verified absent, `deletion_*` timestamps and attempt count recorded; simulated EROFS → `failed`, critical alert + admin email, job rescheduled, recovery → `deleted`, alert resolved; draft file removal and tus DELETE purge partial bytes |
| 10 | Restart/reconciliation/restored metadata cannot resurrect access | `10-restore-reconcile` | DB restored to `active` with old expiry + content re-appearing: still denied; sweep re-deletes; orphans in released/quarantine/incoming removed, live files untouched; lost job recreated; stale lock recovered |
| 11 | Failed/unavailable/oversized/skipped scans never release | `11-scans`, `11b-clamd` | fake scanner modes infected/oversized/timeout/error/unavailable → quarantined, send 409 with reason; unavailable/error retried with alert; oversized released only with explicit policy and labelled; **real clamd**: EICAR → `infected`, 2 MiB clean file → `clean`; protocol parser against a fake daemon (OK/FOUND/size limit/ERROR/empty/unreachable/timeout) |
| 12 | Interrupted uploads/downloads resume correctly | `12-resume` | resume from HEAD offset, replayed chunk 409, byte-exact result; declared size enforced (mismatch 400, oversize PATCH refused, partial never finalises); overlapping ranges 0-999 + 500-1499 + 1500- → coverage `[0,3000)`, bytes_served 2000, exactly one completion, one allowance |
| 13 | Large files with bounded memory | `13-large-bounded-memory` | see below |
| 14 | Parallel downloads cannot bypass the cap | `14-parallel-cap` | 5 concurrent starts vs cap 2 → 2×200, 3×429, `downloads_used`=2; zip refused without consuming; admin max caps sender; 20 concurrent ranges in one session = one allowance |
| 15 | Notifications idempotent, prefs, bounded retries, suppression | `15-notifications` | upload alone emails nobody; duplicates de-duplicated; revoked-before-delivery → `suppressed`; SMTP 451 retried with backoff then sent; 8 failures → `failed` + dead job + alert + `invitation.failed`; prefs and global choice locks; every-download de-duplicated; security notices |
| 16 | Policy precedence, tightening, retention | `16-policy` | unit precedence; tightening upgrades bearer transfers and revokes bearer sessions (audited with reason, counted); loosening leaves existing transfers; secrets write-only; lockout guards; metadata anonymised at 90 days, audit purged at 365 days via SECURITY DEFINER only |
| 17 | No leakage | `17-leakage` | pino output captured: no token/OTP/session ids; token path redacted in request logs; DB stores hashes; outbox scrubbed after delivery; public link state has no title/filenames/address; CSV formula neutralisation; sender/auditor scoping; download/API security headers; CSRF header + origin checks |
| 18 | Mobile + keyboard journeys | — | browser-level; covered by the Playwright suite in `tests/e2e` (separate evidence) |

## Large-file / bounded-memory results

Measured in this container (4 vCPU, 15 GiB RAM, local disk), API and worker **in the same Node
process as the test client**, so the figures include the client's chunk buffers and verification
buffers. The point of the measurement is that growth does not scale with file size.

| Size | tus chunk | Concurrency | Upload | Scan (fake, clamd limit is 100 MiB here) | Download + verify | RSS baseline | RSS peak | Growth |
|---|---|---|---|---|---|---|---|---|
| 1 GiB | 16 MiB | 1 | 12.2 s | 12 ms | 12.4 s | 142 MiB | 298 MiB | 156 MiB |
| 2 GiB | 16 MiB | 1 | 25.9 s | 10 ms | 23.0 s | 145 MiB | 299 MiB | 153 MiB |
| 1 GiB | 64 MiB | 1 | 9.9 s | 18 ms | 8.0 s | 140 MiB | 469 MiB | 330 MiB (client buffers dominate; assertion threshold 300 MiB failed for this chunk size) |

Content was verified byte-for-byte against a deterministic generator on download. Server-side
streams use 1 MiB high-water marks; the tus file store writes chunks straight to disk.

**Not demonstrated**: 100 GiB files, 250 GiB transfers, multi-user concurrency at scale, and
scanning of files above the configured `StreamMaxLength`. Those remain configuration ceilings to be
validated on the target server with its real disk, as the brief requires.

## Untested / out of scope for this suite

* A real Microsoft Entra ID tenant (only claim validation and discovery error handling are tested;
  the OIDC code exchange itself is exercised by openid-client against a live IdP only).
* A real SMTP relay (nodemailer transport is verified by `MemoryMailer` substitution; `SmtpMailer`
  is configuration-only here). Use Administration → Notifications → "Send test message".
* WebAuthn ceremonies (require an authenticator; the server-side verification uses
  `@simplewebauthn/server` and the TOTP/recovery paths are tested end to end).
* Browser behaviour (Playwright suite, separate).
* Full ClamAV signature database (freshclam) — only the EICAR signature was available offline.

## Backend bugs found and fixed by the suite

1. **OTP failure bookkeeping was rolled back.** `verifyCode` threw inside the caller's transaction,
   so failed-attempt counters, lockouts and the `recipient.verification_failed` audit never
   persisted — the 5-attempt limit did not work. Fixed by returning a result and converting to an
   HTTP error after commit (`services/recipients.ts`, `routes/recipient.ts`).
2. **Scanner failure bookkeeping was rolled back.** On `unavailable`/`error` the scan handler threw
   inside its transaction, losing the audit event, in-app notice, operational alert and the reset to
   `pending`; the file was left as `scanning`. Fixed by committing first and signalling the retry
   afterwards (`worker/handlers.ts`).
3. **Deadlocks between concurrent scan/finalise jobs on one transfer**, and an audit hash-chain
   fork race (two transactions reading the same previous hash). Fixed with a consistent lock
   order (transfer row first) and a transaction-scoped advisory lock inside `audit()`
   (`lib/audit.ts`, `worker/handlers.ts`, `routes/uploads.ts`). Lock-ordering rule documented in
   `audit()`.
4. **Concurrent deletion jobs** (expiry-scheduled, on-demand, reconcile) all ran at once and
   inflated `deletion_attempts`. Now only one run claims a transfer; stale `in_progress` runs are
   reset by the sweep after 15 minutes (`services/deletion.ts`, `worker/handlers.ts`).
5. **Worker tick could stall** because in-flight bookkeeping was removed in a late microtask, so a
   second `tick` saw no free slots; also `drain()` had an argument-order trap (`worker/run.ts`).
6. **Outbox rows retained raw invitation links and codes after delivery.** They are now scrubbed
   once sent/suppressed/failed (`worker/handlers.ts`).
7. **Auditor masking** hid recipient addresses only on `recipient`-kind events; anonymous
   link-fetch events linked to a grant also carried the address. Fixed (`routes/audit.ts`).
8. Audit detail key `secretsUpdated` was itself redacted by the secret-key filter; renamed to
   `updatedSecretFields` (`routes/admin.ts`).
9. `bootstrap.ts` gained an optional log destination so tests can capture logs; `app.ts` logger
   typing fix.

## Documented design decision surfaced by the tests

Append-only audit rows keep *email-at-event* (recipient and staff addresses) until **audit**
retention expires (default 365 days). The **metadata** retention (default 90 days after deletion)
anonymises the live tables (titles, filenames, grant addresses, verification rows, outbox). Rewriting
audit rows would break the hash chain; if shorter retention of addresses in the audit trail is
required, lower `auditRetentionDays` (minimum 30). This is recorded in `PRIVACY-DECISIONS.md`
territory for the operator.

## Browser journeys (Playwright, `pnpm test:e2e`)

Run against the dev stack (`scripts/e2e-env.sh`: API :3000, worker, Vite :5173) with the file mail
sink in `var/mail`; Chromium from `/opt/pw-browsers`. Projects: `desktop` (1360×900) and `mobile`
(Pixel 7 emulation, recipient journey).

```
Running 3 tests using 1 worker
  ✓  1 [desktop] › specs/recipient-journey.spec.ts › recipient verifies by email code and downloads on mobile (5.2s)
  ✓  2 [desktop] › specs/sender-journey.spec.ts › sender creates, uploads, scans and sends a transfer (keyboard navigation) (20.9s)
  ✓  3 [mobile]  › specs/recipient-journey.spec.ts › recipient verifies by email code and downloads on mobile (28.6s)
  3 passed (56.7s)
```

What they prove (requirement 18): sign-in with password + TOTP through the real UI; keyboard
navigation to *New transfer* and keyboard-triggered *Send*; a real tus upload through the browser;
honest scan/ready states; the plain-English summary; invitation email without filenames; on a
mobile viewport, that opening the link shows no title/filename and sends no code, that the code is
sent only on explicit request, verification, file list, a real browser download whose completion
is recorded server-side (not at click time).

Note on one-time codes: the helpers wait for the next 30-second TOTP step when a code for the
shared dev account has already been used (server-side replay protection working as intended).
