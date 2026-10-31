# Threat model

## Assets
1. File content (quarantine, released, tus partial uploads, scanner/zip scratch) under `/srv/snelson/content`.
2. Transfer metadata: titles, messages, filenames, recipient addresses, download activity.
3. Credentials and secrets: password hashes, TOTP seeds, passkeys, recovery codes, session tokens,
   invitation tokens, one-time codes, OIDC client secret, SMTP password, `SERVER_SECRET_KEY`.
4. The audit trail (integrity and confidentiality).
5. Service availability (disk, scanner, worker).

## Actors
* **External recipient** – holds an invitation link; may be the intended person or someone it was forwarded to.
* **Internet attacker** – no link; scans, guesses, floods.
* **Staff sender** – authenticated; may be careless or malicious toward other senders' data.
* **Auditor / administrator** – privileged metadata access; no content access by default.
* **Operator with root / database access** – outside the application's control.
* **Automated link scanners** (mail security products) that fetch every URL in an email.

## Threats and controls
| Threat | Controls (where) | Residual |
|---|---|---|
| Forwarded invitation link used by a third party | Per-recipient 32-byte token, stored as SHA-256 (`recipient_grants.token_hash`); fetching the link only records "link requested" (`recordLinkSeen`); the one-time code is emailed **only** to the grant's original address (`requestCode`); the code is HMAC-hashed, 10 min, 5 attempts, atomic single consumption (`verifyCode`); the resulting session is bound to grant + transfer (`loadRecipientSession`); bearer mode is an explicit admin policy and is labelled as unverified everywhere | Someone with access to the recipient's mailbox is indistinguishable from the recipient; files already downloaded can be shared onward |
| Automated scanner "views" | GET/HEAD never send codes, consume allowances or mark verified views; events are labelled "may be an automated scanner" | None beyond honest labelling |
| Staff account compromise | Argon2id passwords, lockout after 10 failures, mandatory MFA before any sender/admin action (`requireAuth level=full`), passkeys with user verification, TOTP replay protection, single-use recovery codes, password reset never bypasses MFA and revokes sessions, security notices on factor changes, step-up (`recent: true`) for sensitive actions, server-side sessions with idle/absolute limits and revocation, SSO relies on IdP Conditional Access + optional `amr` check | Session hijack within the idle window; IdP misconfiguration |
| Malicious upload | Files land in `incoming/` → `quarantine/` and are only moved to `released/` after clamd returns OK (`worker/handlers.scanFile`); every non-OK outcome (FOUND, ERROR, timeout, unavailable, oversized, encrypted archive via `AlertEncrypted`) blocks release; archives are never extracted by the app; downloads use `Content-Disposition: attachment`, `nosniff`, `CSP sandbox`, no inline preview; blocked extension list in policy | Files above `StreamMaxLength` are not scanned; signature-based detection is not complete; zero-day content |
| IDOR / enumeration | Random UUIDs and 24-byte upload ids; every query scoped by `sender_id`; tus hooks re-check ownership per request (`routes/uploads.ts ownedFile`); generic 404 for "not found" and "not yours"; recipient routes keyed by unguessable token | None known |
| Brute force (login, OTP, tokens) | Rate limits per route and per source; account lockout; OTP attempt cap and resend cooldown; per-grant/transfer/source hourly code caps; constant-time comparison; 256-bit tokens | Distributed attempts across many sources are limited only by per-grant caps |
| Quota / disk exhaustion | Declared size required at registration; per-file, per-transfer, per-user and organisation quotas including reservations (`addFile`); tus `maxSize`; size verified at finalisation; abandoned-upload sweep; low-disk alerts and refusal below the critical threshold | A sender can still fill their own quota with junk |
| Worker outage | Expiry and revocation are enforced on the request path from server time (`isAccessible`), not by jobs; the access watcher kills live streams; on restart the worker recovers stale jobs, expires overdue transfers first and reconciles storage; alerts for deletion backlog and dead jobs | Physical deletion cannot happen while the worker is down; the delay is visible in System health |
| Unsafe restore | Time-based expiry and persisted deletion flags survive restore; content is never restored; reconcile removes orphans (docs/RUNBOOK-BACKUP-RESTORE.md) | Old dumps + current `SERVER_SECRET_KEY` keep old wrapped secrets recoverable |
| Privileged operators | Admins/auditors have no content endpoints; audit rows are INSERT-only via trigger and hash-chained (`lib/audit.ts verifyChain`); CSV export is itself audited; secrets are encrypted and never returned to the browser | Root or a DB superuser can read content from disk, disable the trigger, or rewrite the chain. A single-host log is not tamper-proof; ship exports to a remote append-only store if that matters |
| Leaked secrets | Tokens/codes/session ids stored hashed; OIDC/SMTP secrets encrypted with `SERVER_SECRET_KEY`; logs redact cookies, tokens, codes; proxy logs redact `/r/<token>`; `Referrer-Policy: no-referrer`; CSP forbids third-party scripts | `SERVER_SECRET_KEY` compromise exposes TOTP seeds and stored secrets → rotate and re-enrol |
| CSRF | SameSite=Lax cookies plus a required `X-Requested-With` header and Origin check on state-changing API calls (`app.ts`) | None known |
| Clickjacking / XSS | `frame-ancestors 'none'`, strict CSP (`script-src 'self'`), React escaping, HTML email built with escaping | `style-src 'unsafe-inline'` is allowed for the UI |

## Residual risks (stated for the record)
* **Root / hypervisor**: a compromised host, a hypervisor or storage administrator, or a snapshot of the
  unlocked volume can read content and defeat deletion. Volume encryption only protects powered-off storage.
* **Swap, dumps, scanner temp**: mitigated by encrypted/disabled swap, disabled core dumps and tmpfs
  scratch (docs/INSTALL.md). These are host settings the application cannot verify; System health shows
  only what the containers can see.
* **SSD erasure**: `unlink` plus verification removes the file from the filesystem; it is not a physical
  overwrite. Wear-levelled flash may retain blocks until trimmed/erased. We rely on full-volume encryption
  for the "at rest" guarantee, not on overwriting.
* **Proxy and mail logs**: the Caddy/nginx configurations redact tokens; third-party mail relays will have
  the invitation and code emails in their logs for their own retention period.
* **No end-to-end encryption**: the server scans plaintext; this is a deliberate tradeoff for malware scanning.
* **Scanner coverage**: files larger than `StreamMaxLength` (4000 MB default) are not scanned. Large media
  or disk images are common and will show as "oversized"; the policy switch to release them unscanned is
  off by default and each release is audited.
