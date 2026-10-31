# Requirement → implementation checklist

Status key: **Done** (implemented and tested) · **Done (untested externally)** (implemented; depends on an external system not available in the build environment) · **Partial** · **Not done**.
Test ids refer to `apps/api/src/test/NN-*.test.ts` and `tests/e2e/specs/*.spec.ts`; results are in `TEST-EVIDENCE.md`.

## 1 Product and environment
| Requirement | Status | Where |
|---|---|---|
| Configurable product name, logo, support details | Done | `packages/shared/src/policy.ts` (Branding), `apps/web/src/pages/admin/Settings.tsx` |
| Single organisation, multiple uploaders, no anonymous upload | Done | all upload routes require a `sender`/`admin` session (`apps/api/src/routes/uploads.ts`) |
| Bytes, temp files, scanning, DB stay on own infrastructure | Done | `deploy/docker-compose.yml`; no cloud storage/analytics/error tracking anywhere |
| SMTP and IdP as explicit external dependencies | Done | `apps/api/src/lib/mailer.ts`, `apps/api/src/auth/oidc.ts`, `docs/INSTALL.md` |

## 2 Design
| Requirement | Status | Where |
|---|---|---|
| Tokens, system font, restrained UI, no purple gradients/glass/stock art | Done | `apps/web/src/styles/global.css`, screenshots |
| Desktop shell: narrow nav, compact top bar, New transfer action | Done | `apps/web/src/components/Shell.tsx` |
| Transfer table with filters/search | Done | `apps/web/src/pages/Transfers.tsx` |
| Detail: files + recipient progress, side panel policy + receipt | Done | `apps/web/src/pages/TransferDetail.tsx` |
| Two-column composer with chips, expiry, prefs, plain-English summary | Done | `apps/web/src/pages/NewTransfer.tsx` |
| Recipient page: branded, no shell, nothing before authorisation | Done | `apps/web/src/pages/Recipient.tsx`, `apps/api/src/routes/recipient.ts`, test 17 |
| All states incl. deletion pending/failed/deleted vs expired | Done | `apps/web/src/components/Status.tsx` |
| UK English, UTC storage, Europe/London display, absolute + countdown | Done | `packages/shared/src/format.ts`, `apps/web/src/lib/time.ts` |
| Keyboard, focus, reduced motion, responsive, status not colour-only | Done | global.css; e2e sender journey uses keyboard; mobile project |

## 3 Core journeys
| Requirement | Status | Where |
|---|---|---|
| SSO or local + MFA sign-in | Done / Done (untested externally for SSO) | `routes/auth.ts`, test 02, 03 |
| Create transfer, files, title, message, recipients | Done | `services/transfers.ts` |
| Expiry within limits, download limits, notifications | Done | `resolvePolicy()` in `services/transfers.ts`, test 16 |
| Resumable upload with progress/speed/ETA/cancel | Done | tus (`routes/uploads.ts`), `pages/NewTransfer.tsx`, test 12 |
| Quarantine until scan passes; cannot send/download otherwise | Done | `worker/handlers.ts::scanFile`, `sendBlockers()`, test 11 |
| Explicit send; upload alone never emails | Done | `sendTransfer()`; invitations queued only there; test 06/15 |
| Per-recipient activity | Done | `transferDetail()` grants view + receipt |
| Revoke recipient/transfer, delete now, audited extension, no resurrection | Done | `revokeGrant`, `revokeTransfer`, `extendExpiry` (refuses when deletion started), test 07 |
| Immutable after send; add recipient = audited fresh grant | Done | `MUTABLE` guard, `addRecipientAfterSend()` |
| Recipient: link → explicit code request → verify → download, progress/guidance | Done | `routes/recipient.ts`, `services/recipients.ts`, e2e recipient journey |
| Honest wording about mailbox control vs identity | Done | recipient page footer, receipt copy, `docs/DOWNLOAD-SEMANTICS.md` |

## 4 Authentication and authorisation
| Requirement | Status | Where |
|---|---|---|
| Entra ID / generic OIDC, code+PKCE, state, nonce, issuer/tenant/audience | Done (untested against a live tenant) | `auth/oidc.ts`, test 03 (claim validation), `docs/ENTRA-SETUP.md` |
| Explicit tenant + user/group allow lists; no email-suffix access; no email auto-linking | Done | `validateClaims()`, callback refuses email clash |
| Role mapping from trusted config; deprovisioning via groups; session limits documented | Done | `roleFromGroups()`, role re-evaluated each login; `docs/ENTRA-SETUP.md` |
| IdP MFA honoured (`amr`/`acr_values`), dependency described | Done | `requireAmrMfa`, `acrValues` settings |
| Local accounts: invited, verified email, argon2id, mandatory MFA (passkeys UV, TOTP, recovery codes) | Done | `auth/passwords.ts`, `auth/mfa.ts`, `routes/auth.ts`, test 02 |
| Enrolment, recovery, reset, session revocation, step-up | Done | `routes/auth.ts`; password reset creates no session |
| Security notices on sensitive changes | Done | `services/notifications.ts::securityNotice`, test 15 |
| HttpOnly SameSite cookies, CSRF, rotation, idle/absolute limits, server-side revocation | Done | `auth/sessions.ts`, `app.ts` CSRF hook |
| Roles sender/auditor/admin with object-level checks everywhere | Done | `requireAuth()`, ownership in SQL, test 01 |
| Secure bootstrap without default credentials; emergency access | Done | `cli.ts bootstrap-admin`, `docs/EMERGENCY-ACCESS.md` |

## 5 Recipient access and policy
| Requirement | Status | Where |
|---|---|---|
| Per-recipient high-entropy tokens, hashes stored | Done | `recipient_grants.token_hash`, `issueGrantToken()` |
| OTP: 10 min, 5 attempts, 60 s cooldown, rate limits per grant/transfer/source, configurable | Done | `VerificationPolicySchema`, `requestCode()`, test 05 |
| Secure codes, HMAC storage, atomic single use, resend invalidates, no OTP in logs | Done | `verifyCode()`, test 05, 17 |
| Short-lived scoped session, re-verification, never outlives transfer | Done | `createRecipientSession()` |
| Policy modes required / sender_choice / disabled with explanation and audit | Done | settings UI + `config.changed` audit |
| Admin max, sender may strengthen; tightening applies, loosening does not | Done | `computeEffectivePolicy()`, `routes/admin.ts` PUT settings, test 16 |
| Policy version recorded on transfer | Done | `policy_versions`, `transfers.effective_policy` |
| Limits: expiry, bytes, count, quotas, types, domains, downloads, retention | Done | `TransferPolicySchema`, `addFile()`, `checkRecipientPolicy()` |
| No MFA-off switch for local accounts | Done | no such setting exists; `requireAuth` always needs `full` |

## 6 Large-file data path
| Requirement | Status | Where |
|---|---|---|
| Maintained resumable protocol, bounded memory, resume, ownership, idempotent | Done | `@tus/server` + `routes/uploads.ts`, test 12, 13 |
| Quota reservation, abandoned cleanup, limits during upload and at finalisation | Done | `storage_reservations`, `maxSize`, size equality check, sweep |
| 100 GiB / 250 GiB configurable targets | Done (ceilings configurable; tested at 1 GiB – see TEST-EVIDENCE) | `TransferPolicySchema` |
| Traversal/symlink/collision protection, random ids, Unicode names | Done | `lib/storage.ts`, `lib/filenames.ts`, test 18 |
| Isolated scanner with explicit limits; non-clean outcomes never release; oversized honest | Done | `lib/scanner.ts`, `deploy/clamd.conf`, test 11, 11b |
| Downloads: authorised, live checks incl. ranges, bounded streaming | Done | `services/downloads.ts`, test 07, 12 |
| Download-all ZIP64 streaming without temp archive; individual resume | Done | `streamZip()` (archiver, store), `docs/DOWNLOAD-SEMANTICS.md` |
| Attachment disposition, nosniff, no-store, no-referrer, no third-party scripts | Done | `securityHeaders()`, helmet CSP, test 17 |

## 7 Expiry, revocation, deletion
| Requirement | Status | Where |
|---|---|---|
| Expiry enforced on every request with server time | Done | `isAccessible()`, test 07 |
| Streams stop within 5 s | Done | `services/accessWatcher.ts`, test 08 |
| Delete all copies, verify, separate access/deletion state, tracked fields | Done | `services/deletion.ts`, test 09 |
| Durable, idempotent jobs + reconciliation; restart recovery; overdue first | Done | `lib/jobs.ts`, `worker/run.ts`, `expireSweep`, `reconcileStorage`, test 10 |
| Encrypted content volume excluded from backups; swap/dumps guidance | Done (operator procedure) | `docs/INSTALL.md`, `deploy/backup.sh` |
| Honest limits (no SSD overwrite claim, no E2EE claim) | Done | `docs/THREAT-MODEL.md` |
| Separate audit retention and metadata anonymisation | Done | `purgeAudit()`, `AuditPolicySchema`, test 16 |

## 8 Tracking and audit
| Requirement | Status | Where |
|---|---|---|
| Distinct events for the whole lifecycle, precise wording | Done | event names in `services/*`, `apps/web/src/lib/events.ts` |
| Completion = all bytes streamed, range coverage without double counting, client ack separate | Done | `recordServed()`, `mergeRanges()`, test 12, 14 |
| Allowance semantics, atomic reservation, resume does not consume | Done | `reserveAttempt()`, test 14 |
| Structured, append-only records with hash chain and verification | Done | `lib/audit.ts`, DB trigger, System health chain check |
| Search + CSV export, formula-injection safe, scoped by role | Done | `routes/audit.ts`, test 17 |
| Receipt survives content deletion until metadata retention | Done | `transferActivity()`, `metadata_purged_at` |

## 9 Notifications
| Requirement | Status | Where |
|---|---|---|
| SMTP + in-app centre, templates with text fallback | Done | `lib/templates.ts`, `routes/notifications.ts` |
| Matrix implemented incl. admin alerts and security notices | Done | `services/notifications.ts`, `worker/handlers.ts` |
| Transactional outbox, idempotency, bounded retries, suppression on revoke/expiry | Done | `outbox_messages`, `deliverOutbox()`, test 15 |
| No recipients visible to each other; no filenames/codes in subjects or tracking URLs | Done | one message per recipient; templates |
| Template preview and test send to a typed address | Done | `routes/admin.ts` |
| Teams/webhook adapter | Not done (documented as future adapter) | `docs/OPERATIONS.md` |

## 10 Administration
All eight settings sections, user management, SSO test before enforcement, masked secrets never returned, recent-auth + reason for sensitive changes, System health with liveness/readiness separation: **Done** (`routes/admin.ts`, `apps/web/src/pages/admin/*`, `routes/health.ts`).

## 11 Implementation and deployment
Compose with separate api/worker/db/clamav/caddy, only 80/443 exposed, non-root, limits, health checks, no docker socket, pinned images; migrations; env example; bootstrap; install/upgrade/rollback; DNS/TLS; proxy guidance; disk/encryption; SMTP; Entra; backup/restore: **Done** (`deploy/`, `docs/`). Image build itself could not be executed here (no Docker daemon) – see TEST-EVIDENCE.
Threat model and ASVS mapping: **Done** (`docs/THREAT-MODEL.md`, `docs/ASVS-MAP.md`). Dependency scanning: `pnpm audit` documented in `docs/UPGRADE.md`.

## 12 Tests
See `TEST-EVIDENCE.md` for commands and output. Mapping: 1→01, 2→02, 3→03, 4→04, 5→05, 6→06, 7→07, 8→08, 9→09, 10→10, 11→11/11b, 12→12, 13→13 (opt-in `LARGE_TESTS=1`), 14→14, 15→15, 16→16, 17→17, 18→`tests/e2e`.

## Known gaps and limitations
* SSO was validated against crafted claim sets and discovery logic, not a live Entra tenant.
* SMTP was validated with in-memory/file sinks; the production relay must be tested with the built-in test send.
* Large-file evidence is at the size stated in TEST-EVIDENCE.md; 100 GiB has not been exercised.
* Streamed ZIP downloads cannot be resumed (by design; individual files can).
* No Teams/webhook notification adapter in v1.
* TOTP enrolment shows the secret and otpauth link instead of a rendered QR code.
