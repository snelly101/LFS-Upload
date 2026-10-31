# OWASP ASVS 5.0 mapping (Level 2 target)

Status: **I** implemented, **P** partial, **N/A** not applicable, **O** operator responsibility.
References are to `apps/api/src` unless stated.

| ASVS chapter | Requirement (summary) | Status | Evidence |
|---|---|---|---|
| V2 Authentication | Password ≥ 12 chars, no truncation, breached/common list | P | `auth/passwords.ts` (min 12, max 128, small deny list; no external breach-list) |
| V2 | Argon2id / memory-hard hashing | I | `@node-rs/argon2`, m=64 MiB, t=3 |
| V2 | Anti-automation: lockout, rate limiting | I | lockout after 10 failures (15 min); `@fastify/rate-limit` per route |
| V2 | MFA: TOTP, WebAuthn with UV, recovery codes single-use | I | `auth/mfa.ts`; recovery codes argon2-hashed and consumed under row lock |
| V2 | Credential recovery does not bypass MFA; sessions revoked on reset | I | `routes/auth.ts /password/reset` |
| V2 | Notifications on credential/factor changes | I | `securityNotice()` on enrol/remove/reset/role change |
| V2 | Federated login: issuer/audience/nonce/state/PKCE validation, allow lists | I | `auth/oidc.ts validateClaims`, tests `oidc.test.ts` |
| V3 Session management | Server-side sessions, random ≥ 128-bit ids, stored hashed | I | `auth/sessions.ts` (256-bit, SHA-256) |
| V3 | Idle and absolute timeouts, rotation on privilege change, logout invalidates | I | idle 60 min / absolute 12 h defaults; `rotateSession` after MFA |
| V3 | Cookie attributes Secure/HttpOnly/SameSite | I | `cookieOptions()` |
| V3 | Re-authentication for sensitive operations | I | `requireAuth({recent:true})`, 15 min window |
| V3 | Admin can revoke sessions; list active sessions | I | `/api/auth/sessions`, `/api/admin/users/:id/revoke-sessions` |
| V4 Access control | Deny by default; object-level checks server-side | I | every query scoped by owner; tus hooks; recipient session binding; test `isolation.test.ts` |
| V4 | Least privilege roles; admin cannot read content | I | no content routes for admin/auditor |
| V4 | CSRF protection for cookie auth | I | `app.ts` header + Origin check |
| V5 Validation | Schema validation of all input | I | zod on every route |
| V5 | Output encoding; safe filenames; no path traversal | I | `lib/filenames.ts`, `Storage.pathFor` id regex |
| V5 | Parameterised SQL | I | `pg` with placeholders throughout |
| V5 | Spreadsheet formula injection prevented in exports | I | `routes/audit.ts csvCell` |
| V6 Cryptography | Approved algorithms; keys ≥ 256 bit; secrets encrypted at rest | I | AES-256-GCM, HMAC-SHA-256, CSPRNG (`lib/crypto.ts`) |
| V6 | Key management / rotation procedure | P | single `SERVER_SECRET_KEY`; rotation = re-enter secrets and re-enrol TOTP (documented, not automated) |
| V7 Logging | Security events logged with time, actor, outcome; no secrets in logs | I | `lib/audit.ts` + pino redaction |
| V7 | Log integrity / tamper evidence | P | hash chain + INSERT-only trigger; remote append-only export is an operator task |
| V7 | Time synchronised, UTC | O | host NTP; app stores timestamptz |
| V8 Data protection | Sensitive data not cached; no-store headers; minimisation in email | I | `securityHeaders()`, templates omit filenames/recipients |
| V8 | Data retention and purge | I | audit retention, metadata anonymisation (`purgeAudit`) |
| V8 | Encryption at rest | O | LUKS per docs/INSTALL.md |
| V9 Communication | TLS 1.2+, HSTS | I/O | Caddy defaults, HSTS header |
| V11 Business logic | Anti-automation on OTP; limits enforced server-side; immutable after send | I | `services/recipients.ts`, `services/transfers.ts` |
| V12 Files | Size limits before and during upload; random storage names; no execution; AV scan; attachment disposition | I | `addFile`, tus `maxSize`, `scanFile`, download headers |
| V12 | Archive bomb / nested archive limits | I/O | clamd `MaxRecursion/MaxFiles/MaxScanSize`; app never extracts |
| V12 | Files not served from a web-accessible directory | I | content root outside web root; streamed by handler |
| V13 API | JSON only, content-type enforced, generic errors, correlation id | I | Fastify body parser, error handler |
| V14 Configuration | Dependencies pinned, no default credentials, secrets outside code, security headers, CSP | I | `.npmrc`, `bootstrap-admin`, `.env`, helmet |
| V14 | Containers minimal privilege | I | compose: non-root, cap_drop, read-only rootfs, no docker socket |
| V14 | Dependency vulnerability scanning | O | run `pnpm audit` in CI (not shipped as a workflow in this repo) |

Not claimed: ASVS Level 3 items (e.g. HSM-backed keys, formal log forwarding), SAML, breached-password
service integration, automated secret rotation.
