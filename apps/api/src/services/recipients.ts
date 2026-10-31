import type { AppContext } from '../context.js';
import { HttpError, badRequest } from '../context.js';
import type { Queryable } from '../db.js';
import { audit, type AuditInput } from '../lib/audit.js';
import { hmacSha256, randomNumericCode, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import { isAccessible, type TransferRow } from './transfers.js';
import { queueEmail, inApp } from './notifications.js';
import type { RecipientAuthorisedView, RecipientPublicView } from '@snelson/shared';

export interface GrantRow {
  id: string;
  transfer_id: string;
  email: string;
  status: 'pending' | 'invited' | 'revoked';
  downloads_used: number;
  first_link_seen_at: Date | null;
  first_verified_at: Date | null;
  all_files_completed_at: Date | null;
}

export interface RecipientSessionRow {
  id: string;
  grant_id: string;
  transfer_id: string;
  verified_email: string | null;
  mode: 'required' | 'bearer';
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export const RECIPIENT_COOKIE = 'ss_recipient';
const TOKEN_RE = /^[A-Za-z0-9_-]{40,50}$/;

export type GrantLookup = { grant: GrantRow; transfer: TransferRow } | null;

/** Resolve an invitation token to its grant/transfer without side effects. */
export async function lookupGrant(q: Queryable, token: string): Promise<GrantLookup> {
  if (!TOKEN_RE.test(token)) return null;
  const r = await q.query<GrantRow & { t: TransferRow }>(
    `SELECT g.*, to_jsonb(t) AS t FROM recipient_grants g JOIN transfers t ON t.id = g.transfer_id WHERE g.token_hash = $1`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { t, ...grant } = row;
  return { grant, transfer: t };
}

/** Classify the public state of a link. Reveals nothing beyond the state and a masked recipient hint. */
export function publicState(ctx: AppContext, l: GrantLookup): RecipientPublicView['state'] {
  if (!l) return 'not_found';
  const now = ctx.clock.now();
  const { grant, transfer } = l;
  if (grant.status === 'revoked' || transfer.status === 'revoked') return 'revoked';
  if (transfer.status === 'expired' || new Date(transfer.expires_at) <= now) return 'expired';
  if (!isAccessible(transfer, now) || grant.status !== 'invited') return 'unavailable';
  return transfer.verification_mode === 'bearer' ? 'bearer_ready' : 'needs_verification';
}

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const shown = local.length <= 2 ? local[0] ?? '' : local.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(2, Math.min(6, local.length - shown.length)))}@${domain}`;
}

function recipientActor(a: Partial<AuditInput>, grant: GrantRow): Omit<AuditInput, 'eventType'> {
  return { actorKind: 'recipient', actorEmail: grant.email, transferId: grant.transfer_id, grantId: grant.id, ...a };
}

/** Anonymous GET of the link: records first-seen (heuristic, may be a scanner) and nothing else. */
export async function recordLinkSeen(q: Queryable, l: NonNullable<GrantLookup>, a: Partial<AuditInput>) {
  if (!l.grant.first_link_seen_at) {
    await q.query(`UPDATE recipient_grants SET first_link_seen_at = now() WHERE id = $1 AND first_link_seen_at IS NULL`, [l.grant.id]);
  }
  await audit(q, { ...recipientActor(a, l.grant), actorKind: 'anonymous', eventType: 'recipient.link_requested', outcome: 'info', details: { note: 'unverified fetch; may be an automated link scanner' } });
}

/**
 * Issue a verification code. Enforces cooldown and hourly caps per grant, transfer and source prefix.
 * Previous codes are superseded. The code is only ever sent to the grant's original address.
 */
export async function requestCode(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, a: Partial<AuditInput>): Promise<{ ok: true; cooldownSeconds: number }> {
  const { grant, transfer } = l;
  if (publicState(ctx, l) !== 'needs_verification') throw new HttpError(409, 'Verification is not available for this link', 'not_available');
  const vp = await ctx.settings.get('verification');
  const eff = transfer.effective_policy;
  const ttl = eff.codeTtlSeconds ?? vp.codeTtlSeconds;
  const cooldown = eff.resendCooldownSeconds ?? vp.resendCooldownSeconds;
  const now = ctx.clock.now();
  const last = (await q.query<{ issued_at: Date }>(`SELECT issued_at FROM recipient_verifications WHERE grant_id = $1 ORDER BY issued_at DESC LIMIT 1 FOR UPDATE`, [grant.id])).rows[0];
  if (last && now.getTime() - new Date(last.issued_at).getTime() < cooldown * 1000) {
    const wait = Math.ceil((cooldown * 1000 - (now.getTime() - new Date(last.issued_at).getTime())) / 1000);
    throw new HttpError(429, `Please wait ${wait} seconds before requesting another code`, 'cooldown', { retryAfterSeconds: wait });
  }
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const perGrant = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM recipient_verifications WHERE grant_id = $1 AND issued_at > $2`, [grant.id, hourAgo])).rows[0]!.n;
  const perTransfer = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM recipient_verifications v JOIN recipient_grants g ON g.id = v.grant_id WHERE g.transfer_id = $1 AND v.issued_at > $2`, [transfer.id, hourAgo])).rows[0]!.n;
  const perSource = a.ipPrefix ? (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM recipient_verifications WHERE ip_prefix = $1 AND issued_at > $2`, [a.ipPrefix, hourAgo])).rows[0]!.n : 0;
  if (perGrant >= vp.maxCodesPerGrantPerHour || perTransfer >= vp.maxCodesPerTransferPerHour || perSource >= vp.maxCodesPerSourcePerHour) {
    // Written outside the caller's transaction so the denial survives the throw/rollback.
    await audit(ctx.db, { ...recipientActor(a, grant), eventType: 'recipient.code_rate_limited', outcome: 'denied' });
    throw new HttpError(429, 'Too many codes requested. Please try again later.', 'rate_limited');
  }
  await q.query(`UPDATE recipient_verifications SET superseded_at = now() WHERE grant_id = $1 AND consumed_at IS NULL AND superseded_at IS NULL`, [grant.id]);
  const code = randomNumericCode(vp.codeDigits);
  const codeHash = hmacSha256(ctx.config.serverKey, `${grant.id}:${code}`);
  await q.query(
    `INSERT INTO recipient_verifications(grant_id, code_hash, issued_at, expires_at, max_attempts, ip_prefix) VALUES ($1,$2,$3,$4,$5,$6)`,
    [grant.id, codeHash, now, new Date(now.getTime() + ttl * 1000), eff.maxAttempts ?? vp.maxAttempts, a.ipPrefix ?? null],
  );
  const sender = (await q.query<{ display_name: string; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [transfer.sender_id])).rows[0]!;
  await queueEmail(q, {
    kind: 'verification_code',
    to: grant.email,
    transferId: transfer.id,
    grantId: grant.id,
    data: { code, ttlMinutes: Math.round(ttl / 60), senderName: sender.display_name || sender.email },
    // no dedupe key: every explicit request sends a fresh code (previous invalidated above)
  });
  await audit(q, { ...recipientActor(a, grant), eventType: 'recipient.code_requested', outcome: 'info' });
  return { ok: true, cooldownSeconds: cooldown };
}

export type VerifyResult = { ok: true; token: string; session: RecipientSessionRow } | { ok: false; status: number; reason: string };

/**
 * Verify a code atomically (row lock + single consumption) and create a scoped recipient session.
 * Failures are returned (not thrown) so the attempt counter and audit record commit with the
 * caller's transaction; the route converts them to HTTP errors after commit.
 */
export async function verifyCode(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, code: string, a: Partial<AuditInput>): Promise<VerifyResult> {
  const { grant, transfer } = l;
  if (publicState(ctx, l) !== 'needs_verification') return { ok: false, status: 409, reason: 'not_available' };
  const now = ctx.clock.now();
  const v = (
    await q.query<{ id: string; code_hash: Buffer; expires_at: Date; attempts: number; max_attempts: number; consumed_at: Date | null; locked_at: Date | null }>(
      `SELECT id, code_hash, expires_at, attempts, max_attempts, consumed_at, locked_at FROM recipient_verifications
        WHERE grant_id = $1 AND superseded_at IS NULL ORDER BY issued_at DESC LIMIT 1 FOR UPDATE`,
      [grant.id],
    )
  ).rows[0];
  const fail = async (reason: string, status = 401): Promise<VerifyResult> => {
    await audit(q, { ...recipientActor(a, grant), eventType: 'recipient.verification_failed', outcome: 'denied', details: { reason } });
    return { ok: false, status, reason };
  };
  if (!v) return fail('no_code');
  if (v.consumed_at) return fail('already_used');
  if (v.locked_at || v.attempts >= v.max_attempts) return fail('locked', 429);
  if (new Date(v.expires_at) <= now) return fail('expired');
  const expected = hmacSha256(ctx.config.serverKey, `${grant.id}:${code.trim()}`);
  if (!safeEqual(expected, v.code_hash)) {
    const attempts = v.attempts + 1;
    await q.query(`UPDATE recipient_verifications SET attempts = $2, locked_at = CASE WHEN $2 >= max_attempts THEN now() ELSE NULL END WHERE id = $1`, [v.id, attempts]);
    return fail(attempts >= v.max_attempts ? 'locked' : 'mismatch', attempts >= v.max_attempts ? 429 : 401);
  }
  const consumed = await q.query(`UPDATE recipient_verifications SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL`, [v.id]);
  if (!consumed.rowCount) return fail('race');
  const first = !grant.first_verified_at;
  await q.query(`UPDATE recipient_grants SET first_verified_at = COALESCE(first_verified_at, $2), last_verified_at = $2 WHERE id = $1`, [grant.id, now]);
  const s = await createRecipientSession(ctx, q, l, 'required', a);
  await audit(q, { ...recipientActor(a, grant), actorSessionId: s.session.id, eventType: 'recipient.verified', details: { first } });
  if (first) await notifySender(ctx, q, transfer, grant, 'firstVerifiedView', `${grant.email} verified their email and opened "${transfer.title || 'Untitled transfer'}"`, `firstview:${grant.id}`);
  return { ok: true, ...s };
}

/** Bearer-mode access: explicit action creates an unverified session. Never recorded as a verified person. */
export async function bearerSession(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, a: Partial<AuditInput>) {
  if (publicState(ctx, l) !== 'bearer_ready') throw new HttpError(409, 'Not available', 'not_available');
  const s = await createRecipientSession(ctx, q, l, 'bearer', a);
  await audit(q, { ...recipientActor(a, l.grant), actorKind: 'anonymous', actorSessionId: s.session.id, eventType: 'recipient.bearer_access', outcome: 'info', details: { note: 'bearer link; holder identity not verified' } });
  return s;
}

async function createRecipientSession(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, mode: 'required' | 'bearer', a: Partial<AuditInput>) {
  const { grant, transfer } = l;
  const vp = await ctx.settings.get('verification');
  const minutes = transfer.effective_policy.recipientSessionMinutes ?? vp.recipientSessionMinutes;
  const now = ctx.clock.now();
  // Sessions never outlive the transfer.
  const expires = new Date(Math.min(now.getTime() + minutes * 60_000, new Date(transfer.expires_at).getTime()));
  const token = randomToken(32);
  const r = await q.query<RecipientSessionRow>(
    `INSERT INTO recipient_sessions(grant_id, transfer_id, token_hash, verified_email, mode, created_at, expires_at, last_seen_at, ip_prefix) VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8) RETURNING *`,
    [grant.id, transfer.id, sha256(token), mode === 'required' ? grant.email : null, mode, now, expires, a.ipPrefix ?? null],
  );
  return { token, session: r.rows[0]! };
}

/** Load a recipient session and check it still authorises access to this grant/transfer. */
export async function loadRecipientSession(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, token: string | undefined): Promise<RecipientSessionRow | null> {
  if (!token || !TOKEN_RE.test(token)) return null;
  const r = await q.query<RecipientSessionRow>(`SELECT * FROM recipient_sessions WHERE token_hash = $1`, [sha256(token)]);
  const s = r.rows[0];
  if (!s) return null;
  const now = ctx.clock.now();
  if (s.grant_id !== l.grant.id || s.transfer_id !== l.transfer.id) return null; // bound to grant + transfer
  if (s.revoked_at || new Date(s.expires_at) <= now) return null;
  if (!isAccessible(l.transfer, now) || l.grant.status !== 'invited') return null;
  // Policy tightening: a bearer session is invalid once the transfer requires verification.
  if (l.transfer.verification_mode === 'required' && s.mode !== 'required') return null;
  return s;
}

export async function authorisedView(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, s: RecipientSessionRow): Promise<RecipientAuthorisedView> {
  const { grant, transfer } = l;
  const sender = (await q.query<{ display_name: string; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [transfer.sender_id])).rows[0]!;
  const files = (
    await q.query<{ id: string; display_name: string; size_bytes: number }>(
      `SELECT id, display_name, size_bytes FROM transfer_files WHERE transfer_id = $1 AND upload_status = 'finalised' AND storage_state = 'released' ORDER BY created_at`,
      [transfer.id],
    )
  ).rows;
  const limit = transfer.download_limit_per_recipient;
  return {
    title: transfer.title,
    message: transfer.message,
    senderName: sender.display_name || sender.email,
    senderEmail: sender.email,
    recipientEmail: s.verified_email,
    expiresAt: new Date(transfer.expires_at).toISOString(),
    files: files.map((f) => ({ id: f.id, name: f.display_name, sizeBytes: f.size_bytes })),
    totalBytes: files.reduce((n, f) => n + f.size_bytes, 0),
    downloadsRemaining: limit === null ? null : Math.max(0, limit - grant.downloads_used),
    sessionExpiresAt: new Date(s.expires_at).toISOString(),
    allowZip: files.length > 1,
  };
}

export async function notifySender(ctx: AppContext, q: Queryable, transfer: TransferRow, grant: GrantRow | null, pref: string, detail: string, dedupeKey: string) {
  const sender = (await q.query<{ id: string; email: string; notification_prefs: Record<string, boolean> }>(`SELECT id, email, notification_prefs FROM users WHERE id = $1`, [transfer.sender_id])).rows[0];
  if (!sender) return;
  await inApp(q, { userId: sender.id, kind: pref, title: detail, transferId: transfer.id, dedupeKey: `inapp:${dedupeKey}` });
  const wantsEmail = transfer.notify_prefs[pref] ?? false;
  if (!wantsEmail) return;
  await queueEmail(q, {
    kind: 'sender_activity',
    to: sender.email,
    toUserId: sender.id,
    transferId: transfer.id,
    grantId: grant?.id ?? null,
    data: { kind: pref, transferTitle: transfer.title || 'Untitled transfer', recipientEmail: grant?.email ?? null, link: new URL(`/transfers/${transfer.id}`, ctx.config.publicUrl).toString(), detail },
    dedupeKey: `mail:${dedupeKey}`,
  });
}

export function assertToken(token: string) {
  if (!TOKEN_RE.test(token)) throw badRequest('Invalid link');
}
