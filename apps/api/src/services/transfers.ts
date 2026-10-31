import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { AppContext } from '../context.js';
import { badRequest, conflict, forbidden, notFound } from '../context.js';
import type { Queryable } from '../db.js';
import { audit, type AuditInput } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { dedupeFilename, sanitiseFilename } from '../lib/filenames.js';
import { enqueue } from '../lib/jobs.js';
import { computeEffectivePolicy } from '../lib/settings.js';
import { queueEmail, inApp } from './notifications.js';
import type { EffectivePolicy, TransferDetail, TransferSummary, TransferFileView, GrantView } from '@snelson/shared';

export interface TransferRow {
  id: string;
  sender_id: string;
  sender_email_at_event: string;
  title: string;
  message: string;
  status: TransferSummary['status'];
  verification_mode: 'required' | 'bearer';
  expires_at: Date;
  sent_at: Date | null;
  revoked_at: Date | null;
  expired_at: Date | null;
  download_limit_per_recipient: number | null;
  notify_prefs: Record<string, boolean>;
  policy_version_id: number | null;
  effective_policy: EffectivePolicy;
  total_bytes: number;
  file_count: number;
  deletion_status: TransferSummary['deletionStatus'];
  deletion_requested_at: Date | null;
  deletion_started_at: Date | null;
  deletion_completed_at: Date | null;
  deletion_attempts: number;
  deletion_last_error: string | null;
  metadata_purged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface FileRow {
  id: string;
  transfer_id: string;
  upload_id: string | null;
  display_name: string;
  original_name: string;
  size_bytes: number;
  content_type: string;
  upload_status: TransferFileView['uploadStatus'];
  scan_status: TransferFileView['scanStatus'];
  scan_detail: string | null;
  storage_state: 'none' | 'incoming' | 'quarantine' | 'released' | 'deleted';
  uploaded_bytes: number;
  created_at: Date;
}

export type ActorInfo = Omit<AuditInput, 'eventType'> & { actorUserId: string; actorEmail: string };

const MUTABLE = new Set(['draft', 'uploading', 'scanning', 'ready']);

/** Access to content requires all of these, evaluated against server time on every request. */
export function isAccessible(t: Pick<TransferRow, 'status' | 'expires_at' | 'deletion_status'>, now: Date): boolean {
  return t.status === 'active' && new Date(t.expires_at) > now && t.deletion_status === 'none';
}

export async function loadOwnedTransfer(q: Queryable, transferId: string, userId: string, forUpdate = false): Promise<TransferRow> {
  const r = await q.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1 AND sender_id = $2 ${forUpdate ? 'FOR UPDATE' : ''}`, [transferId, userId]);
  const t = r.rows[0];
  if (!t) throw notFound('Transfer not found');
  return t;
}

export const CreateTransferSchema = z.object({
  title: z.string().max(200).default(''),
  message: z.string().max(4000).default(''),
  expiresAt: z.string().datetime().optional(),
  verificationMode: z.enum(['required', 'bearer']).optional(),
  downloadLimitPerRecipient: z.number().int().min(1).max(1000).nullable().optional(),
  notifyPrefs: z.record(z.boolean()).default({}),
});
export type CreateTransferInput = z.infer<typeof CreateTransferSchema>;

/** Validate sender choices against admin policy; returns effective values. */
async function resolvePolicy(ctx: AppContext, q: Queryable, input: CreateTransferInput, now: Date, sentAt: Date | null) {
  const s = await ctx.settings.all();
  const tp = s.transferPolicy;
  const base = sentAt ?? now;
  const maxExpiry = new Date(base.getTime() + tp.maxExpiryHours * 3_600_000);
  let expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(now.getTime() + tp.defaultExpiryHours * 3_600_000);
  if (Number.isNaN(expiresAt.getTime())) throw badRequest('Invalid expiry');
  if (expiresAt <= now) throw badRequest('Expiry must be in the future', 'expiry_past');
  if (expiresAt > maxExpiry) throw badRequest(`Expiry cannot be later than ${tp.maxExpiryHours} hours after sending`, 'expiry_too_late', { maxExpiresAt: maxExpiry.toISOString() });
  if (input.verificationMode === 'bearer' && s.verification.mode === 'required') throw badRequest('Email verification is required by policy', 'verification_required');
  const policyVersionId = await ctx.settings.latestPolicyVersionId(q);
  const eff = computeEffectivePolicy(s, { verificationMode: input.verificationMode, downloadLimit: input.downloadLimitPerRecipient ?? null }, policyVersionId);
  const notifyPrefs: Record<string, boolean> = {};
  for (const [k, def] of Object.entries(s.notifications.defaults)) {
    const allowed = (s.notifications.senderChoices as Record<string, boolean>)[k] ?? true;
    notifyPrefs[k] = allowed ? (input.notifyPrefs[k] ?? def) : def;
  }
  return { expiresAt, eff, notifyPrefs, settings: s };
}

export async function createTransfer(ctx: AppContext, q: Queryable, user: { id: string; email: string }, input: CreateTransferInput, a: ActorInfo): Promise<TransferRow> {
  const now = ctx.clock.now();
  const { expiresAt, eff, notifyPrefs } = await resolvePolicy(ctx, q, input, now, null);
  const r = await q.query<TransferRow>(
    `INSERT INTO transfers(sender_id, sender_email_at_event, title, message, status, verification_mode, expires_at, download_limit_per_recipient, notify_prefs, policy_version_id, effective_policy, search_text)
     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [user.id, user.email, input.title.trim(), input.message, eff.verificationMode, expiresAt, eff.maxDownloadsPerRecipient, JSON.stringify(notifyPrefs), eff.policyVersionId, JSON.stringify(eff), input.title.toLowerCase()],
  );
  const t = r.rows[0]!;
  await audit(q, { ...a, eventType: 'transfer.created', transferId: t.id, details: { verificationMode: eff.verificationMode, expiresAt: expiresAt.toISOString(), policyVersionId: eff.policyVersionId } });
  return t;
}

export async function updateTransfer(ctx: AppContext, q: Queryable, user: { id: string; email: string }, transferId: string, input: Partial<CreateTransferInput>, a: ActorInfo): Promise<TransferRow> {
  const t = await loadOwnedTransfer(q, transferId, user.id, true);
  if (!MUTABLE.has(t.status)) throw conflict('Transfer has been sent and is immutable', 'immutable');
  const now = ctx.clock.now();
  const merged: CreateTransferInput = {
    title: input.title ?? t.title,
    message: input.message ?? t.message,
    expiresAt: input.expiresAt ?? new Date(t.expires_at).toISOString(),
    verificationMode: input.verificationMode ?? t.verification_mode,
    downloadLimitPerRecipient: input.downloadLimitPerRecipient === undefined ? t.download_limit_per_recipient : input.downloadLimitPerRecipient,
    notifyPrefs: input.notifyPrefs ?? t.notify_prefs,
  };
  const { expiresAt, eff, notifyPrefs } = await resolvePolicy(ctx, q, merged, now, null);
  const r = await q.query<TransferRow>(
    `UPDATE transfers SET title = $2, message = $3, verification_mode = $4, expires_at = $5, download_limit_per_recipient = $6, notify_prefs = $7, policy_version_id = $8, effective_policy = $9, search_text = $10 WHERE id = $1 RETURNING *`,
    [t.id, merged.title.trim(), merged.message, eff.verificationMode, expiresAt, eff.maxDownloadsPerRecipient, JSON.stringify(notifyPrefs), eff.policyVersionId, JSON.stringify(eff), buildSearchText(merged.title, [])],
  );
  await audit(q, { ...a, eventType: 'transfer.updated', transferId: t.id, details: { fields: Object.keys(input) } });
  return r.rows[0]!;
}

function buildSearchText(title: string, emails: string[]) {
  return [title, ...emails].join(' ').toLowerCase();
}

export async function quotaUsage(q: Queryable, userId: string): Promise<{ usedBytes: number; reservedBytes: number }> {
  const u = await q.query<{ used: number | null }>(
    `SELECT sum(f.size_bytes)::bigint AS used FROM transfer_files f JOIN transfers t ON t.id = f.transfer_id WHERE t.sender_id = $1 AND f.storage_state IN ('incoming','quarantine','released')`,
    [userId],
  );
  const r = await q.query<{ reserved: number | null }>(`SELECT sum(bytes)::bigint AS reserved FROM storage_reservations WHERE user_id = $1`, [userId]);
  return { usedBytes: u.rows[0]?.used ?? 0, reservedBytes: r.rows[0]?.reserved ?? 0 };
}

export async function orgUsage(q: Queryable): Promise<{ usedBytes: number; reservedBytes: number }> {
  const u = await q.query<{ used: number | null }>(`SELECT sum(size_bytes)::bigint AS used FROM transfer_files WHERE storage_state IN ('incoming','quarantine','released')`);
  const r = await q.query<{ reserved: number | null }>(`SELECT sum(bytes)::bigint AS reserved FROM storage_reservations`);
  return { usedBytes: u.rows[0]?.used ?? 0, reservedBytes: r.rows[0]?.reserved ?? 0 };
}

export const AddFileSchema = z.object({
  name: z.string().min(1).max(1000),
  sizeBytes: z.number().int().min(0),
  contentType: z.string().max(200).default('application/octet-stream'),
});

/**
 * Register a file and reserve quota/disk before any byte is accepted. Limits are also enforced by
 * the tus layer during upload (maxSize) and at finalisation (actual size must equal declared size).
 */
export async function addFile(ctx: AppContext, q: Queryable, user: { id: string; email: string; quota_bytes: number | null }, transferId: string, input: z.infer<typeof AddFileSchema>, a: ActorInfo): Promise<FileRow> {
  const t = await loadOwnedTransfer(q, transferId, user.id, true);
  if (!MUTABLE.has(t.status)) throw conflict('Transfer has been sent and is immutable', 'immutable');
  const s = await ctx.settings.all();
  const tp = s.transferPolicy;
  if (input.sizeBytes > tp.maxFileBytes) throw badRequest(`File exceeds the maximum size per file`, 'file_too_large', { maxFileBytes: tp.maxFileBytes });
  const files = await q.query<FileRow>(`SELECT * FROM transfer_files WHERE transfer_id = $1 AND upload_status <> 'abandoned'`, [t.id]);
  if (files.rows.length >= tp.maxFilesPerTransfer) throw badRequest('Too many files in this transfer', 'too_many_files', { max: tp.maxFilesPerTransfer });
  const total = files.rows.reduce((n, f) => n + f.size_bytes, 0) + input.sizeBytes;
  if (total > tp.maxTransferBytes) throw badRequest('Transfer exceeds the maximum total size', 'transfer_too_large', { maxTransferBytes: tp.maxTransferBytes });
  const safeName = dedupeFilename(sanitiseFilename(input.name), new Set(files.rows.map((f) => f.display_name.toLowerCase())));
  const ext = safeName.includes('.') ? safeName.split('.').pop()!.toLowerCase() : '';
  if (tp.blockedExtensions.includes(ext)) throw badRequest(`Files of type .${ext} are not permitted`, 'blocked_type');
  if (tp.allowedExtensions.length && !tp.allowedExtensions.includes(ext)) throw badRequest(`Files of type .${ext || '(none)'} are not permitted`, 'blocked_type');
  // quota: user + organisation, including reservations for in-flight uploads
  const quota = user.quota_bytes ?? tp.defaultUserQuotaBytes;
  const usage = await quotaUsage(q, user.id);
  if (quota > 0 && usage.usedBytes + usage.reservedBytes + input.sizeBytes > quota) throw badRequest('Your storage quota would be exceeded', 'quota_exceeded', { quotaBytes: quota, usedBytes: usage.usedBytes + usage.reservedBytes });
  const org = await orgUsage(q);
  if (tp.organisationQuotaBytes > 0 && org.usedBytes + org.reservedBytes + input.sizeBytes > tp.organisationQuotaBytes) throw badRequest('The organisation storage quota would be exceeded', 'org_quota_exceeded');
  const disk = await ctx.storage.diskUsage();
  const headroom = Math.floor(disk.totalBytes * (s.storage.lowDiskCriticalPercent / 100));
  if (disk.availableBytes - org.reservedBytes - input.sizeBytes < headroom) throw badRequest('Not enough free storage on the server for this file', 'disk_full');
  const uploadId = randomToken(24).replace(/[^A-Za-z0-9_-]/g, '');
  const r = await q.query<FileRow>(
    `INSERT INTO transfer_files(transfer_id, upload_id, display_name, original_name, size_bytes, content_type, upload_status, storage_state)
     VALUES ($1,$2,$3,$4,$5,$6,'pending','none') RETURNING *`,
    [t.id, uploadId, safeName, input.name.slice(0, 1000), input.sizeBytes, input.contentType.slice(0, 200)],
  );
  const f = r.rows[0]!;
  await q.query(`INSERT INTO storage_reservations(file_id, user_id, bytes) VALUES ($1,$2,$3)`, [f.id, user.id, input.sizeBytes]);
  await q.query(`UPDATE transfers SET status = CASE WHEN status = 'draft' THEN 'uploading'::transfer_status ELSE status END, file_count = file_count + 1, total_bytes = total_bytes + $2 WHERE id = $1`, [t.id, input.sizeBytes]);
  await audit(q, { ...a, eventType: 'file.registered', transferId: t.id, fileId: f.id, details: { displayName: safeName, sizeBytes: input.sizeBytes } });
  await recomputeTransferStatus(q, t.id);
  return f;
}

export async function removeFile(ctx: AppContext, q: Queryable, userId: string, transferId: string, fileId: string, a: ActorInfo) {
  const t = await loadOwnedTransfer(q, transferId, userId, true);
  if (!MUTABLE.has(t.status)) throw conflict('Transfer has been sent and is immutable', 'immutable');
  const f = (await q.query<FileRow>(`SELECT * FROM transfer_files WHERE id = $1 AND transfer_id = $2 FOR UPDATE`, [fileId, t.id])).rows[0];
  if (!f) throw notFound('File not found');
  // Physical bytes are removed by the deletion worker; mark abandoned now so nothing can use it.
  await q.query(`UPDATE transfer_files SET upload_status = 'abandoned' WHERE id = $1`, [f.id]);
  await q.query(`DELETE FROM storage_reservations WHERE file_id = $1`, [f.id]);
  await q.query(`UPDATE transfers SET file_count = file_count - 1, total_bytes = total_bytes - $2 WHERE id = $1`, [t.id, f.size_bytes]);
  await enqueue(q, 'delete_transfer', { transferId: t.id, fileId: f.id, mode: 'file' }, { idempotencyKey: `delete-file:${f.id}`, priority: 20 });
  await audit(q, { ...a, eventType: 'file.removed', transferId: t.id, fileId: f.id });
  await recomputeTransferStatus(q, t.id);
}

/** Derive transfer status from its files while unsent. */
export async function recomputeTransferStatus(q: Queryable, transferId: string) {
  const t = (await q.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1 FOR UPDATE`, [transferId])).rows[0];
  if (!t || !MUTABLE.has(t.status)) return;
  const files = (await q.query<FileRow>(`SELECT * FROM transfer_files WHERE transfer_id = $1 AND upload_status <> 'abandoned'`, [transferId])).rows;
  let status: TransferRow['status'] = 'draft';
  if (files.length) {
    if (files.some((f) => f.upload_status !== 'finalised')) status = 'uploading';
    else if (files.some((f) => f.scan_status === 'pending' || f.scan_status === 'scanning')) status = 'scanning';
    else status = 'ready';
  }
  if (status !== t.status) await q.query(`UPDATE transfers SET status = $2 WHERE id = $1`, [transferId, status]);
}

export function sendBlockers(t: TransferRow, files: FileRow[], grants: { status: string }[], allowUnscannedOversized: boolean): string[] {
  const out: string[] = [];
  if (files.length === 0) out.push('Add at least one file.');
  if (grants.filter((g) => g.status !== 'revoked').length === 0) out.push('Add at least one recipient.');
  for (const f of files) {
    if (f.upload_status !== 'finalised') out.push(`${f.display_name}: upload not finished.`);
    else if (f.scan_status === 'pending' || f.scan_status === 'scanning') out.push(`${f.display_name}: scan in progress.`);
    else if (f.scan_status === 'infected') out.push(`${f.display_name}: blocked by malware scan.`);
    else if (f.scan_status === 'oversized' && !allowUnscannedOversized) out.push(`${f.display_name}: too large for the malware scanner and unscanned release is not permitted.`);
    else if (f.scan_status !== 'clean' && !(f.scan_status === 'oversized' && allowUnscannedOversized)) out.push(`${f.display_name}: scan ${f.scan_status}.`);
  }
  if (!MUTABLE.has(t.status)) out.push('Transfer already sent.');
  return out;
}

export const RecipientsSchema = z.array(z.string().email().max(254)).min(1).max(200);

function normaliseEmails(list: string[]): string[] {
  return [...new Set(list.map((e) => e.trim().toLowerCase()))];
}

async function checkRecipientPolicy(ctx: AppContext, emails: string[], existingCount: number) {
  const s = await ctx.settings.all();
  const tp = s.transferPolicy;
  if (existingCount + emails.length > tp.maxRecipientsPerTransfer) throw badRequest('Too many recipients', 'too_many_recipients', { max: tp.maxRecipientsPerTransfer });
  if (tp.allowedRecipientDomains.length) {
    for (const e of emails) {
      const dom = e.split('@')[1] ?? '';
      if (!tp.allowedRecipientDomains.some((d) => dom === d.toLowerCase() || dom.endsWith('.' + d.toLowerCase()))) throw badRequest(`Recipients at ${dom} are not permitted`, 'domain_not_allowed', { domain: dom });
    }
  }
}

/** Replace the recipient list of an unsent transfer. */
export async function setRecipients(ctx: AppContext, q: Queryable, userId: string, transferId: string, emails: string[], a: ActorInfo) {
  const t = await loadOwnedTransfer(q, transferId, userId, true);
  if (!MUTABLE.has(t.status)) throw conflict('Transfer has been sent; add recipients individually instead', 'immutable');
  const list = normaliseEmails(emails);
  await checkRecipientPolicy(ctx, list, 0);
  const existing = (await q.query<{ id: string; email: string }>(`SELECT id, email FROM recipient_grants WHERE transfer_id = $1`, [t.id])).rows;
  for (const g of existing) if (!list.includes(g.email.toLowerCase())) await q.query(`DELETE FROM recipient_grants WHERE id = $1`, [g.id]);
  for (const email of list) {
    if (existing.some((g) => g.email.toLowerCase() === email)) continue;
    await q.query(`INSERT INTO recipient_grants(transfer_id, email, token_hash, status, added_by) VALUES ($1,$2,$3,'pending',$4)`, [t.id, email, sha256(randomToken(32)), userId]);
  }
  await q.query(`UPDATE transfers SET search_text = $2 WHERE id = $1`, [t.id, buildSearchText(t.title, list)]);
  await audit(q, { ...a, eventType: 'transfer.recipients_set', transferId: t.id, details: { count: list.length } });
}

/** Issue a fresh token for a grant (at send, resend, or add-after-send). Returns the raw token. */
async function issueGrantToken(q: Queryable, grantId: string): Promise<string> {
  const token = randomToken(32);
  await q.query(`UPDATE recipient_grants SET token_hash = $2 WHERE id = $1`, [grantId, sha256(token)]);
  return token;
}

export function recipientLink(ctx: AppContext, token: string): string {
  return new URL(`/r/${token}`, ctx.config.publicUrl).toString();
}

async function queueInvitation(ctx: AppContext, q: Queryable, t: TransferRow, grant: { id: string; email: string }, token: string, sender: { display_name: string; email: string }, attempt: number) {
  await queueEmail(q, {
    kind: 'transfer_available',
    to: grant.email,
    transferId: t.id,
    grantId: grant.id,
    data: {
      senderName: sender.display_name || sender.email,
      senderEmail: sender.email,
      link: recipientLink(ctx, token),
      expiresAt: new Date(t.expires_at).toISOString(),
      fileCount: t.file_count,
      totalBytes: t.total_bytes,
      verificationRequired: t.verification_mode === 'required',
    },
    dedupeKey: `invite:${grant.id}:${attempt}`,
  });
}

/** Explicit send: makes the transfer immutable/active and queues one invitation per recipient. */
export async function sendTransfer(ctx: AppContext, q: Queryable, user: { id: string; email: string; display_name: string }, transferId: string, a: ActorInfo): Promise<TransferRow> {
  const t = await loadOwnedTransfer(q, transferId, user.id, true);
  const files = (await q.query<FileRow>(`SELECT * FROM transfer_files WHERE transfer_id = $1 AND upload_status <> 'abandoned' FOR UPDATE`, [t.id])).rows;
  const grants = (await q.query<{ id: string; email: string; status: string }>(`SELECT id, email, status FROM recipient_grants WHERE transfer_id = $1 FOR UPDATE`, [t.id])).rows;
  const s = await ctx.settings.all();
  const blockers = sendBlockers(t, files, grants, s.transferPolicy.allowUnscannedOversizedRelease);
  if (blockers.length) throw conflict(blockers.join(' '), 'not_ready');
  const now = ctx.clock.now();
  // Re-validate expiry window against policy at send time.
  const maxExpiry = new Date(now.getTime() + s.transferPolicy.maxExpiryHours * 3_600_000);
  const expiresAt = new Date(t.expires_at) > maxExpiry ? maxExpiry : new Date(t.expires_at);
  if (expiresAt <= now) throw conflict('Expiry is in the past; choose a new expiry before sending', 'expiry_past');
  const r = await q.query<TransferRow>(`UPDATE transfers SET status = 'active', sent_at = $2, expires_at = $3 WHERE id = $1 RETURNING *`, [t.id, now, expiresAt]);
  const sent = r.rows[0]!;
  for (const g of grants) {
    const token = await issueGrantToken(q, g.id);
    await q.query(`UPDATE recipient_grants SET status = 'invited', invited_at = $2 WHERE id = $1`, [g.id, now]);
    await queueInvitation(ctx, q, sent, g, token, user, 1);
    await audit(q, { ...a, eventType: 'invitation.queued', transferId: t.id, grantId: g.id, details: { email: g.email } });
  }
  await audit(q, { ...a, eventType: 'transfer.sent', transferId: t.id, details: { recipients: grants.length, files: files.length, totalBytes: sent.total_bytes, expiresAt: expiresAt.toISOString() } });
  await scheduleLifecycleJobs(ctx, q, sent);
  return sent;
}

/** Deletion at expiry + expiring-soon reminder. Idempotent per transfer + expiry timestamp. */
export async function scheduleLifecycleJobs(ctx: AppContext, q: Queryable, t: TransferRow) {
  const exp = new Date(t.expires_at);
  await enqueue(q, 'delete_transfer', { transferId: t.id, mode: 'expiry' }, { idempotencyKey: `delete:${t.id}:${exp.getTime()}`, runAt: exp, priority: 10 });
  const np = await ctx.settings.get('notifications');
  const lead = new Date(exp.getTime() - np.expiringSoonLeadHours * 3_600_000);
  if (lead > ctx.clock.now()) await enqueue(q, 'notify_expiring', { transferId: t.id }, { idempotencyKey: `expiring:${t.id}:${exp.getTime()}`, runAt: lead });
}

export async function addRecipientAfterSend(ctx: AppContext, q: Queryable, user: { id: string; email: string; display_name: string }, transferId: string, email: string, reason: string, a: ActorInfo) {
  const t = await loadOwnedTransfer(q, transferId, user.id, true);
  if (!isAccessible(t, ctx.clock.now())) throw conflict('Transfer is not active', 'not_active');
  const norm = email.trim().toLowerCase();
  const count = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM recipient_grants WHERE transfer_id = $1`, [t.id])).rows[0]!.n;
  await checkRecipientPolicy(ctx, [norm], count);
  const exists = await q.query(`SELECT 1 FROM recipient_grants WHERE transfer_id = $1 AND email = $2`, [t.id, norm]);
  if (exists.rowCount) throw conflict('That recipient already has a grant', 'duplicate');
  const g = (await q.query<{ id: string; email: string }>(`INSERT INTO recipient_grants(transfer_id, email, token_hash, status, invited_at, added_by, added_after_send) VALUES ($1,$2,$3,'invited',now(),$4,true) RETURNING id, email`, [t.id, norm, sha256(randomToken(32)), user.id])).rows[0]!;
  const token = await issueGrantToken(q, g.id);
  await queueInvitation(ctx, q, t, g, token, user, 1);
  await audit(q, { ...a, eventType: 'transfer.recipient_added', transferId: t.id, grantId: g.id, details: { email: norm, reason } });
  await audit(q, { ...a, eventType: 'invitation.queued', transferId: t.id, grantId: g.id, details: { email: norm } });
  return g;
}

export async function resendInvitation(ctx: AppContext, q: Queryable, user: { id: string; email: string; display_name: string }, transferId: string, grantId: string, a: ActorInfo) {
  const t = await loadOwnedTransfer(q, transferId, user.id, true);
  if (!isAccessible(t, ctx.clock.now())) throw conflict('Transfer is not active', 'not_active');
  const g = (await q.query<{ id: string; email: string; status: string }>(`SELECT id, email, status FROM recipient_grants WHERE id = $1 AND transfer_id = $2 FOR UPDATE`, [grantId, t.id])).rows[0];
  if (!g) throw notFound('Recipient not found');
  if (g.status !== 'invited') throw conflict('Recipient grant is not active', 'grant_inactive');
  const n = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_messages WHERE grant_id = $1 AND kind = 'transfer_available'`, [g.id])).rows[0]!.n;
  if (n >= 5) throw conflict('Invitation has already been resent the maximum number of times', 'resend_limit');
  // Rotating the token invalidates the previously emailed link; the old link holder can no longer use it.
  await q.query(`UPDATE recipient_sessions SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL`, [g.id]);
  const token = await issueGrantToken(q, g.id);
  await queueInvitation(ctx, q, t, g, token, user, n + 1);
  await audit(q, { ...a, eventType: 'invitation.resent', transferId: t.id, grantId: g.id, details: { attempt: n + 1 } });
}

export async function revokeGrant(ctx: AppContext, q: Queryable, userId: string, transferId: string, grantId: string, reason: string, a: ActorInfo) {
  const t = await loadOwnedTransfer(q, transferId, userId, true);
  const g = (await q.query<{ id: string; status: string }>(`SELECT id, status FROM recipient_grants WHERE id = $1 AND transfer_id = $2 FOR UPDATE`, [grantId, t.id])).rows[0];
  if (!g) throw notFound('Recipient not found');
  if (g.status === 'revoked') return;
  await q.query(`UPDATE recipient_grants SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE id = $1`, [g.id, userId]);
  await q.query(`UPDATE recipient_sessions SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL`, [g.id]);
  await q.query(`UPDATE outbox_messages SET status = 'suppressed' WHERE grant_id = $1 AND status IN ('queued','failed')`, [g.id]);
  await audit(q, { ...a, eventType: 'grant.revoked', transferId: t.id, grantId: g.id, details: { reason } });
}

export async function revokeTransfer(ctx: AppContext, q: Queryable, userId: string, transferId: string, opts: { reason: string; deleteNow: boolean }, a: ActorInfo) {
  const t = await loadOwnedTransfer(q, transferId, userId, true);
  if (t.status === 'revoked') return t;
  const now = ctx.clock.now();
  await q.query(`UPDATE transfers SET status = 'revoked', revoked_at = $2, revoked_by = $3 WHERE id = $1`, [t.id, now, userId]);
  await q.query(`UPDATE recipient_grants SET status = 'revoked', revoked_at = $2, revoked_by = $3 WHERE transfer_id = $1 AND status <> 'revoked'`, [t.id, now, userId]);
  await q.query(`UPDATE recipient_sessions SET revoked_at = $2 WHERE transfer_id = $1 AND revoked_at IS NULL`, [t.id, now]);
  await q.query(`UPDATE outbox_messages SET status = 'suppressed' WHERE transfer_id = $1 AND status IN ('queued','failed') AND kind IN ('transfer_available','expiring_soon_recipient')`, [t.id]);
  await audit(q, { ...a, eventType: 'transfer.revoked', transferId: t.id, details: { reason: opts.reason, deleteNow: opts.deleteNow } });
  if (opts.deleteNow) await requestDeletion(ctx, q, t.id, 'sender_revoked', a);
  return (await q.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1`, [t.id])).rows[0]!;
}

/** Mark content for deletion and enqueue the durable job. Access is denied from this moment. */
export async function requestDeletion(ctx: AppContext, q: Queryable, transferId: string, reason: string, a: Omit<AuditInput, 'eventType'>) {
  const t = (await q.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1 FOR UPDATE`, [transferId])).rows[0];
  if (!t) throw notFound();
  if (t.deletion_status !== 'none' && t.deletion_status !== 'failed') return;
  const now = ctx.clock.now();
  await q.query(`UPDATE transfers SET deletion_status = 'pending', deletion_requested_at = COALESCE(deletion_requested_at, $2) WHERE id = $1`, [t.id, now]);
  await q.query(`UPDATE recipient_sessions SET revoked_at = $2 WHERE transfer_id = $1 AND revoked_at IS NULL`, [t.id, now]);
  await enqueue(q, 'delete_transfer', { transferId: t.id, mode: 'requested' }, { idempotencyKey: `delete-now:${t.id}:${now.getTime()}`, priority: 5 });
  await audit(q, { ...a, eventType: 'deletion.requested', transferId: t.id, details: { reason } });
}

export async function extendExpiry(ctx: AppContext, q: Queryable, userId: string, transferId: string, newExpiry: Date, reason: string, a: ActorInfo) {
  const t = await loadOwnedTransfer(q, transferId, userId, true);
  const now = ctx.clock.now();
  if (t.deletion_status !== 'none' || t.status !== 'active') throw conflict('Only active transfers with content can be extended; deleted content cannot be resurrected', 'not_extendable');
  const s = await ctx.settings.all();
  if (!s.transferPolicy.allowExpiryExtension) throw forbidden('Expiry extension is not permitted by policy');
  const base = t.sent_at ? new Date(t.sent_at) : now;
  const max = new Date(base.getTime() + s.transferPolicy.maxExpiryHours * 3_600_000);
  if (newExpiry <= now) throw badRequest('New expiry must be in the future', 'expiry_past');
  if (newExpiry > max) throw badRequest('New expiry exceeds the policy maximum', 'expiry_too_late', { maxExpiresAt: max.toISOString() });
  if (!reason.trim()) throw badRequest('A reason is required', 'reason_required');
  const r = await q.query<TransferRow>(`UPDATE transfers SET expires_at = $2 WHERE id = $1 RETURNING *`, [t.id, newExpiry]);
  await audit(q, { ...a, eventType: 'transfer.expiry_changed', transferId: t.id, details: { from: new Date(t.expires_at).toISOString(), to: newExpiry.toISOString(), reason } });
  await scheduleLifecycleJobs(ctx, q, r.rows[0]!);
  return r.rows[0]!;
}

/** Record expiry (time-based access denial already applies) and trigger deletion. Called by sweep/job. */
export async function markExpired(ctx: AppContext, q: Queryable, transferId: string): Promise<boolean> {
  const t = (await q.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1 FOR UPDATE`, [transferId])).rows[0];
  if (!t) return false;
  const now = ctx.clock.now();
  if (!(t.status === 'active' || t.status === 'sending') || new Date(t.expires_at) > now) return false;
  await q.query(`UPDATE transfers SET status = 'expired', expired_at = $2 WHERE id = $1`, [t.id, now]);
  await q.query(`UPDATE recipient_sessions SET revoked_at = $2 WHERE transfer_id = $1 AND revoked_at IS NULL`, [t.id, now]);
  await q.query(`UPDATE outbox_messages SET status = 'suppressed' WHERE transfer_id = $1 AND status IN ('queued','failed') AND kind IN ('transfer_available','expiring_soon_recipient')`, [t.id]);
  await audit(q, { actorKind: 'system', eventType: 'transfer.expired', transferId: t.id, details: { expiresAt: new Date(t.expires_at).toISOString() } });
  // Expired-without-download notice
  const anyDownload = await q.query(`SELECT 1 FROM download_attempts d JOIN recipient_grants g ON g.id = d.grant_id WHERE g.transfer_id = $1 AND d.completed_at IS NOT NULL LIMIT 1`, [t.id]);
  if (!anyDownload.rowCount && t.notify_prefs.expiredWithoutDownload) {
    const sender = (await q.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = $1`, [t.sender_id])).rows[0]!;
    await inApp(q, { userId: sender.id, kind: 'expired_without_download', title: `"${t.title || 'Untitled transfer'}" expired without any completed download`, transferId: t.id, dedupeKey: `expnodl:${t.id}` });
    await queueEmail(q, { kind: 'sender_activity', to: sender.email, toUserId: sender.id, transferId: t.id, data: { kind: 'expired_without_download', transferTitle: t.title || 'Untitled transfer', recipientEmail: null, link: new URL(`/transfers/${t.id}`, ctx.config.publicUrl).toString(), detail: 'Transfer expired without any completed download' }, dedupeKey: `expnodl:${t.id}` });
  }
  await requestDeletion(ctx, q, t.id, 'expired', { actorKind: 'system' });
  return true;
}

// ------------------------------------------------------------------ views
export function fileView(f: FileRow): TransferFileView {
  return {
    id: f.id,
    displayName: f.display_name,
    sizeBytes: f.size_bytes,
    contentType: f.content_type,
    uploadStatus: f.upload_status,
    uploadedBytes: f.uploaded_bytes,
    scanStatus: f.scan_status,
    scanDetail: f.scan_detail,
    storageState: f.storage_state,
    createdAt: new Date(f.created_at).toISOString(),
  };
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export async function transferDetail(ctx: AppContext, q: Queryable, t: TransferRow): Promise<TransferDetail> {
  const files = (await q.query<FileRow>(`SELECT * FROM transfer_files WHERE transfer_id = $1 AND upload_status <> 'abandoned' ORDER BY created_at`, [t.id])).rows;
  const grants = (
    await q.query<{
      id: string; email: string; status: GrantView['status']; invited_at: Date | null; revoked_at: Date | null; added_after_send: boolean; downloads_used: number;
      first_link_seen_at: Date | null; first_verified_at: Date | null; all_files_completed_at: Date | null; files_completed: number; inv_status: string | null;
    }>(
      `SELECT g.*, (SELECT count(*)::int FROM recipient_file_completion c WHERE c.grant_id = g.id) AS files_completed,
              (SELECT o.status::text FROM outbox_messages o WHERE o.grant_id = g.id AND o.kind = 'transfer_available' ORDER BY o.id DESC LIMIT 1) AS inv_status
         FROM recipient_grants g WHERE g.transfer_id = $1 ORDER BY g.created_at`,
      [t.id],
    )
  ).rows;
  const s = await ctx.settings.all();
  const blockers = sendBlockers(t, files, grants, s.transferPolicy.allowUnscannedOversizedRelease);
  const summary = await summaryFor(q, t);
  return {
    ...summary,
    message: t.message,
    verificationMode: t.verification_mode,
    downloadLimitPerRecipient: t.download_limit_per_recipient,
    notifyPrefs: t.notify_prefs,
    effectivePolicy: t.effective_policy as unknown as Record<string, unknown>,
    files: files.map(fileView),
    grants: grants.map((g) => ({
      id: g.id,
      email: g.email,
      status: g.status,
      invitedAt: iso(g.invited_at),
      revokedAt: iso(g.revoked_at),
      addedAfterSend: g.added_after_send,
      downloadsUsed: g.downloads_used,
      firstLinkSeenAt: iso(g.first_link_seen_at),
      firstVerifiedAt: iso(g.first_verified_at),
      allFilesCompletedAt: iso(g.all_files_completed_at),
      filesCompleted: g.files_completed,
      invitationStatus: g.inv_status === 'sent' ? 'accepted_by_provider' : g.inv_status === 'queued' || g.inv_status === 'sending' ? 'queued' : g.inv_status === 'failed' ? 'failed' : g.inv_status === 'suppressed' ? 'suppressed' : 'none',
    })),
    revokedAt: iso(t.revoked_at),
    deletion: { requestedAt: iso(t.deletion_requested_at), startedAt: iso(t.deletion_started_at), completedAt: iso(t.deletion_completed_at), attempts: t.deletion_attempts, lastError: t.deletion_last_error },
    canSend: blockers.length === 0,
    blockingReasons: blockers,
  };
}

async function summaryFor(q: Queryable, t: TransferRow): Promise<TransferSummary> {
  const grants = (await q.query<{ email: string; status: GrantView['status']; all_files_completed_at: Date | null }>(`SELECT email, status, all_files_completed_at FROM recipient_grants WHERE transfer_id = $1 ORDER BY created_at`, [t.id])).rows;
  const dl = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM download_attempts d JOIN recipient_grants g ON g.id = d.grant_id WHERE g.transfer_id = $1 AND d.completed_at IS NOT NULL`, [t.id])).rows[0]!.n;
  const last = (await q.query<{ occurred_at: Date; event_type: string }>(`SELECT occurred_at, event_type FROM audit_events WHERE transfer_id = $1 ORDER BY id DESC LIMIT 1`, [t.id])).rows[0];
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    deletionStatus: t.deletion_status,
    recipients: grants.map((g) => ({ email: g.email, status: g.status })),
    fileCount: t.file_count,
    totalBytes: t.total_bytes,
    expiresAt: new Date(t.expires_at).toISOString(),
    sentAt: iso(t.sent_at),
    createdAt: new Date(t.created_at).toISOString(),
    lastActivityAt: last ? new Date(last.occurred_at).toISOString() : null,
    lastActivityType: last?.event_type ?? null,
    senderEmail: t.sender_email_at_event,
    downloadsCompleted: dl,
    recipientsCompleted: grants.filter((g) => g.all_files_completed_at).length,
  };
}

export const ListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(['all', 'draft', 'active', 'expired', 'revoked', 'deleted']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listTransfers(q: Queryable, scope: { senderId?: string }, query: z.infer<typeof ListQuerySchema>): Promise<{ items: TransferSummary[]; total: number }> {
  const where: string[] = ['metadata_purged_at IS NULL'];
  const params: unknown[] = [];
  if (scope.senderId) {
    params.push(scope.senderId);
    where.push(`sender_id = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${query.q.toLowerCase()}%`);
    where.push(`(search_text LIKE $${params.length} OR EXISTS (SELECT 1 FROM recipient_grants g WHERE g.transfer_id = transfers.id AND g.email::text LIKE $${params.length}))`);
  }
  switch (query.status) {
    case 'draft':
      where.push(`status IN ('draft','uploading','scanning','ready')`);
      break;
    case 'active':
      where.push(`status = 'active' AND deletion_status = 'none'`);
      break;
    case 'expired':
      where.push(`status = 'expired'`);
      break;
    case 'revoked':
      where.push(`status = 'revoked'`);
      break;
    case 'deleted':
      where.push(`deletion_status = 'deleted'`);
      break;
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM transfers ${w}`, params)).rows[0]!.n;
  params.push(query.pageSize, (query.page - 1) * query.pageSize);
  const rows = (await q.query<TransferRow>(`SELECT * FROM transfers ${w} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows;
  const items: TransferSummary[] = [];
  for (const t of rows) items.push(await summaryFor(q, t));
  return { items, total };
}

export async function transferActivity(q: Queryable, transferId: string, limit = 500) {
  const r = await q.query<{ id: number; occurred_at: Date; event_type: string; actor_kind: string; actor_email: string | null; outcome: string; file_id: string | null; grant_id: string | null; details: Record<string, unknown> }>(
    `SELECT id, occurred_at, event_type, actor_kind, actor_email, outcome, file_id, grant_id, details FROM audit_events WHERE transfer_id = $1 ORDER BY id ASC LIMIT $2`,
    [transferId, limit],
  );
  return r.rows.map((e) => ({ id: e.id, occurredAt: e.occurred_at.toISOString(), eventType: e.event_type, actorKind: e.actor_kind, actorEmail: e.actor_email, outcome: e.outcome, fileId: e.file_id, grantId: e.grant_id, transferId, details: e.details }));
}

export type { PoolClient };
