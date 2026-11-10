import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../context.js';
import type { Queryable } from '../db.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { computeEffectivePolicy } from '../lib/settings.js';
import type { RecipientInboundView } from '@securesend/shared';
import * as T from './transfers.js';
import type { GrantLookup, RecipientSessionRow } from './recipients.js';

/**
 * File requests ("inbound transfers"): a member of staff asks named external people to send files.
 * Contributors are addressed by email and must verify that mailbox with a one-time code exactly
 * like download recipients; there is no anonymous upload. Contributors can only add files and see
 * their own uploads. Only the requesting member of staff can download what was received, and only
 * files that passed the malware scan.
 */
export const CreateRequestSchema = z.object({
  title: z.string().trim().min(1, 'Say what you are asking for').max(200),
  message: z.string().max(4000).default(''),
  emails: T.RecipientsSchema,
  expiresAt: z.string().datetime().optional(),
});

export async function createFileRequest(ctx: AppContext, q: Queryable, user: { id: string; email: string; display_name: string }, input: z.infer<typeof CreateRequestSchema>, a: T.ActorInfo): Promise<T.TransferRow> {
  const s = await ctx.settings.all();
  const tp = s.transferPolicy;
  if (!tp.allowFileRequests) throw forbidden('File requests are turned off by your administrator');
  const now = ctx.clock.now();
  const maxExpiry = new Date(now.getTime() + tp.maxExpiryHours * 3_600_000);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(now.getTime() + tp.defaultExpiryHours * 3_600_000);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) throw badRequest('The closing date must be in the future', 'expiry_past');
  if (expiresAt > maxExpiry) throw badRequest(`The closing date cannot be later than ${tp.maxExpiryHours} hours from now`, 'expiry_too_late', { maxExpiresAt: maxExpiry.toISOString() });
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()))];
  await T.checkRecipientPolicy(ctx, emails, 0);
  const policyVersionId = await ctx.settings.latestPolicyVersionId(q);
  // Contributors are always verified: a bearer link would make this an anonymous upload endpoint.
  const eff = { ...computeEffectivePolicy(s, { verificationMode: 'required' }, policyVersionId), verificationMode: 'required' as const };
  const t = (
    await q.query<T.TransferRow>(
      `INSERT INTO transfers(sender_id, sender_email_at_event, title, message, status, direction, verification_mode, expires_at, sent_at, notify_prefs, policy_version_id, effective_policy, search_text)
       VALUES ($1,$2,$3,$4,'active','inbound','required',$5,$6,'{}'::jsonb,$7,$8,$9) RETURNING *`,
      [user.id, user.email, input.title, input.message, expiresAt, now, policyVersionId, JSON.stringify(eff), [input.title, ...emails].join(' ').toLowerCase()],
    )
  ).rows[0]!;
  await audit(q, { ...a, eventType: 'request.created', transferId: t.id, details: { contributors: emails.length, expiresAt: expiresAt.toISOString(), policyVersionId } });
  for (const email of emails) {
    const token = randomToken(32);
    const g = (await q.query<{ id: string; email: string }>(`INSERT INTO recipient_grants(transfer_id, email, token_hash, status, invited_at, added_by) VALUES ($1,$2,$3,'invited',$4,$5) RETURNING id, email`, [t.id, email, sha256(token), now, user.id])).rows[0]!;
    await T.queueInvitation(ctx, q, t, g, token, user, 1);
    await audit(q, { ...a, eventType: 'invitation.queued', transferId: t.id, grantId: g.id, details: { email, purpose: 'upload' } });
  }
  await T.scheduleLifecycleJobs(ctx, q, t);
  return t;
}

/** Stop accepting uploads: every contributor link and session dies. Received files stay until expiry. */
export async function closeFileRequest(ctx: AppContext, q: Queryable, userId: string, transferId: string, reason: string, a: T.ActorInfo): Promise<T.TransferRow> {
  const t = await T.loadOwnedTransfer(q, transferId, userId, true);
  if (t.direction !== 'inbound') throw conflict('Only a file request can be closed', 'not_a_request');
  if (t.closed_at) return t;
  const now = ctx.clock.now();
  await q.query(`UPDATE transfers SET closed_at = $2 WHERE id = $1`, [t.id, now]);
  await q.query(`UPDATE recipient_grants SET status = 'revoked', revoked_at = $2, revoked_by = $3 WHERE transfer_id = $1 AND status <> 'revoked'`, [t.id, now, userId]);
  await q.query(`UPDATE recipient_sessions SET revoked_at = $2 WHERE transfer_id = $1 AND revoked_at IS NULL`, [t.id, now]);
  await q.query(`UPDATE outbox_messages SET status = 'suppressed' WHERE transfer_id = $1 AND status IN ('queued','failed') AND kind = 'file_request'`, [t.id]);
  // Uploads still in flight can no longer be completed; mark them abandoned so their bytes are swept.
  const open = (await q.query<{ id: string; size_bytes: number }>(`SELECT id, size_bytes FROM transfer_files WHERE transfer_id = $1 AND upload_status IN ('pending','uploading') FOR UPDATE`, [t.id])).rows;
  for (const f of open) {
    await q.query(`UPDATE transfer_files SET upload_status = 'abandoned' WHERE id = $1`, [f.id]);
    await q.query(`DELETE FROM storage_reservations WHERE file_id = $1`, [f.id]);
    await q.query(`UPDATE transfers SET file_count = file_count - 1, total_bytes = total_bytes - $2 WHERE id = $1`, [t.id, f.size_bytes]);
  }
  await audit(q, { ...a, eventType: 'request.closed', transferId: t.id, details: { reason, uploadsAbandoned: open.length } });
  return (await q.query<T.TransferRow>(`SELECT * FROM transfers WHERE id = $1`, [t.id])).rows[0]!;
}

/** True while a verified contributor may add files. Evaluated on every request with server time. */
export function acceptingUploads(ctx: AppContext, l: NonNullable<GrantLookup>): boolean {
  return l.transfer.direction === 'inbound' && !l.transfer.closed_at && l.grant.status === 'invited' && T.isAccessible(l.transfer, ctx.clock.now());
}

/** Register one file a contributor is about to upload. Reserves space against the requesting member of staff. */
export async function addInboundFile(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, s: RecipientSessionRow, input: z.infer<typeof T.AddFileSchema>, a: { correlationId?: string | null; ipPrefix?: string | null; userAgent?: string | null }): Promise<T.FileRow> {
  // Lock order: transfer → file → audit (same as every other writer).
  const t = (await q.query<T.TransferRow>(`SELECT * FROM transfers WHERE id = $1 FOR UPDATE`, [l.transfer.id])).rows[0];
  if (!t || t.direction !== 'inbound') throw notFound();
  if (t.closed_at || !T.isAccessible(t, ctx.clock.now())) throw new HttpError(410, 'This request is no longer accepting files', 'gone');
  const g = (await q.query<{ status: string }>(`SELECT status::text FROM recipient_grants WHERE id = $1`, [l.grant.id])).rows[0];
  if (!g || g.status !== 'invited') throw new HttpError(410, 'This request is no longer accepting files', 'gone');
  const owner = (await q.query<{ id: string; quota_bytes: number | null }>(`SELECT id, quota_bytes FROM users WHERE id = $1`, [t.sender_id])).rows[0]!;
  const f = await T.registerFileRow(ctx, q, t, owner, l.grant.id, input);
  await audit(q, { actorKind: 'recipient', actorEmail: s.verified_email, actorSessionId: s.id, transferId: t.id, grantId: l.grant.id, fileId: f.id, eventType: 'inbound.file_registered', details: { displayName: f.display_name, sizeBytes: input.sizeBytes }, ...a });
  return f;
}

function uploadState(f: { upload_status: string; scan_status: string; storage_state: string }): RecipientInboundView['uploads'][number]['state'] {
  if (f.upload_status !== 'finalised') return 'uploading';
  if (f.scan_status === 'pending' || f.scan_status === 'scanning') return 'checking';
  if (f.scan_status === 'infected') return 'blocked';
  if (f.storage_state === 'released') return 'received';
  return f.scan_status === 'clean' ? 'received' : 'failed';
}

/** What a verified contributor sees: the ask, the limits, and only their own uploads. */
export async function inboundView(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, s: RecipientSessionRow): Promise<RecipientInboundView> {
  const { grant, transfer } = l;
  const st = await ctx.settings.all();
  const tp = st.transferPolicy;
  const requester = (await q.query<{ display_name: string; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [transfer.sender_id])).rows[0]!;
  const mine = (
    await q.query<{ id: string; display_name: string; size_bytes: number; uploaded_bytes: number; upload_status: string; scan_status: string; storage_state: string }>(
      `SELECT id, display_name, size_bytes, uploaded_bytes, upload_status::text, scan_status::text, storage_state::text FROM transfer_files
        WHERE transfer_id = $1 AND uploaded_by_grant_id = $2 AND upload_status <> 'abandoned' ORDER BY created_at`,
      [transfer.id, grant.id],
    )
  ).rows;
  const totals = (await q.query<{ n: number; bytes: number | null }>(`SELECT count(*)::int AS n, sum(size_bytes)::bigint AS bytes FROM transfer_files WHERE transfer_id = $1 AND upload_status <> 'abandoned'`, [transfer.id])).rows[0]!;
  const maxFile = T.effectiveMaxFileBytes(tp, ctx.config.CLAMD_MAX_STREAM_BYTES);
  return {
    direction: 'inbound',
    title: transfer.title,
    message: transfer.message,
    requesterName: requester.display_name || requester.email,
    requesterEmail: requester.email,
    recipientEmail: grant.email,
    expiresAt: new Date(transfer.expires_at).toISOString(),
    sessionExpiresAt: new Date(s.expires_at).toISOString(),
    limits: {
      maxFileBytes: maxFile,
      scanLimited: maxFile < tp.maxFileBytes,
      remainingFiles: Math.max(0, tp.maxFilesPerTransfer - totals.n),
      remainingBytes: Math.max(0, tp.maxTransferBytes - (totals.bytes ?? 0)),
      blockedExtensions: tp.blockedExtensions,
    },
    uploads: mine.map((f) => ({ id: f.id, name: f.display_name, sizeBytes: f.size_bytes, uploadedBytes: f.uploaded_bytes, state: uploadState(f) })),
  };
}

/** A received file the owner may download: inbound, scanned clean, content still present. */
export async function ownerDownloadable(ctx: AppContext, q: Queryable, userId: string, transferId: string, fileId: string) {
  const t = await T.loadOwnedTransfer(q, transferId, userId);
  if (t.direction !== 'inbound') throw notFound('File not found');
  if (!T.isAccessible(t, ctx.clock.now())) throw new HttpError(410, 'These files are no longer available', 'gone');
  const f = (await q.query<{ id: string; display_name: string; size_bytes: number; uploaded_by_grant_id: string | null }>(
    `SELECT id, display_name, size_bytes, uploaded_by_grant_id FROM transfer_files WHERE id = $1 AND transfer_id = $2 AND upload_status = 'finalised' AND storage_state = 'released' AND scan_status = 'clean'`,
    [fileId, t.id],
  )).rows[0];
  if (!f) throw notFound('File not found');
  return { t, f };
}
