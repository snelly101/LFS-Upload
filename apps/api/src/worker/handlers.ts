import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { audit } from '../lib/audit.js';
import { enqueue, type ClaimedJob } from '../lib/jobs.js';
import { templates, type TemplateContext, type TemplateKey } from '../lib/templates.js';
import { deleteTransferContent } from '../services/deletion.js';
import { markExpired, recomputeTransferStatus, requestDeletion, type TransferRow } from '../services/transfers.js';
import { inApp, queueEmail, raiseAlert, resolveAlert } from '../services/notifications.js';
import { recipientLink } from '../services/transfers.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { isAccessible } from '../services/transfers.js';

export async function templateContext(ctx: AppContext): Promise<TemplateContext> {
  const b = await ctx.settings.get('branding');
  return { productName: b.productName, organisationName: b.organisationName, supportEmail: b.supportEmail, accentColour: b.accentColour, publicUrl: ctx.config.publicUrl.toString(), timeZone: b.defaultTimeZone };
}

// ------------------------------------------------------------------ scan
export async function scanFile(ctx: AppContext, job: ClaimedJob) {
  const fileId = String(job.payload.fileId);
  const f = (await ctx.db.query<{ id: string; transfer_id: string; size_bytes: number; storage_state: string; scan_status: string; display_name: string }>(`SELECT id, transfer_id, size_bytes, storage_state, scan_status, display_name FROM transfer_files WHERE id = $1`, [fileId])).rows[0];
  if (!f || f.storage_state !== 'quarantine') return; // nothing to do (deleted/abandoned)
  await ctx.db.query(`UPDATE transfer_files SET scan_status = 'scanning' WHERE id = $1`, [f.id]);
  const p = ctx.storage.pathFor('quarantine', f.id);
  const outcome = await ctx.scanner.scanFile(p, f.size_bytes);
  const t = (await ctx.db.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1`, [f.transfer_id])).rows[0]!;
  const s = await ctx.settings.all();
  // Everything below commits even when the scan must be retried; the retry is signalled afterwards
  // so an unavailable scanner never rolls back the audit trail, notices and alerts.
  const retry = await ctx.db.tx(async (c) => {
    await c.query(`SELECT id FROM transfers WHERE id = $1 FOR UPDATE`, [f.transfer_id]); // lock order: transfer → file → audit
    const detail = 'detail' in outcome ? outcome.detail : null;
    const engine = 'engine' in outcome ? outcome.engine : null;
    await c.query(`UPDATE transfer_files SET scan_status = $2, scan_detail = $3, scan_engine = $4, scanned_at = now() WHERE id = $1`, [f.id, outcome.status, detail, engine]);
    const release = outcome.status === 'clean' || (outcome.status === 'oversized' && s.transferPolicy.allowUnscannedOversizedRelease);
    let retry = false;
    if (release) {
      await ctx.storage.move(p, ctx.storage.pathFor('released', f.id));
      await c.query(`UPDATE transfer_files SET storage_state = 'released' WHERE id = $1`, [f.id]);
      await audit(c, { actorKind: 'system', eventType: outcome.status === 'clean' ? 'scan.passed' : 'scan.released_unscanned', transferId: f.transfer_id, fileId: f.id, outcome: outcome.status === 'clean' ? 'success' : 'info', details: { engine, detail } });
    } else {
      const blocked = outcome.status === 'infected';
      await audit(c, { actorKind: 'system', eventType: blocked ? 'scan.blocked' : 'scan.failed', transferId: f.transfer_id, fileId: f.id, outcome: blocked ? 'denied' : 'failure', details: { status: outcome.status, detail } });
      await inApp(c, { userId: t.sender_id, kind: 'scan', title: blocked ? `"${f.display_name}" was blocked by the malware scanner` : `"${f.display_name}" could not be scanned (${outcome.status})`, transferId: f.transfer_id, dedupeKey: `scan:${f.id}:${outcome.status}` });
      if (s.notifications.scanFailureEmail) {
        const sender = (await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [t.sender_id])).rows[0];
        if (sender) await queueEmail(c, { kind: 'sender_activity', to: sender.email, toUserId: t.sender_id, transferId: t.id, data: { kind: 'scan', transferTitle: t.title || 'Untitled transfer', recipientEmail: null, link: new URL(`/transfers/${t.id}`, ctx.config.publicUrl).toString(), detail: blocked ? `A file was blocked by the malware scanner: ${f.display_name}` : `A file could not be scanned (${outcome.status}): ${f.display_name}` }, dedupeKey: `scanmail:${f.id}:${outcome.status}` });
      }
      if (outcome.status === 'unavailable' || outcome.status === 'error' || outcome.status === 'timeout') {
        await raiseAlert(ctx, c, { kind: 'scanner', severity: 'warning', message: `Malware scanner ${outcome.status}: ${detail ?? ''}`.trim(), dedupeKey: `scanner:${outcome.status}` });
        if (outcome.status === 'unavailable' || outcome.status === 'error') {
          // retry later; the file stays quarantined and blocked meanwhile
          await c.query(`UPDATE transfer_files SET scan_status = 'pending' WHERE id = $1`, [f.id]);
          retry = true;
        }
      }
    }
    await recomputeTransferStatus(c, f.transfer_id);
    return retry;
  });
  if (retry) throw new Error(`scanner ${outcome.status}: ${'detail' in outcome ? outcome.detail : ''}`);
}

// ------------------------------------------------------------------ deletion
export async function deleteTransfer(ctx: AppContext, job: ClaimedJob) {
  const transferId = String(job.payload.transferId);
  const mode = String(job.payload.mode ?? 'expiry');
  if (mode === 'file') {
    const r = await deleteTransferContent(ctx, transferId, { fileId: String(job.payload.fileId) });
    if (r === 'failed') throw new Error('file deletion failed');
    return;
  }
  if (mode === 'expiry') {
    // Ensure expiry has been recorded (also denies access by time regardless).
    await ctx.db.tx((c) => markExpired(ctx, c, transferId));
  }
  const t = (await ctx.db.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1`, [transferId])).rows[0];
  if (!t) return;
  if (t.deletion_status === 'none') {
    if (isAccessible(t, ctx.clock.now())) return; // extended since scheduling; a new job exists for the new expiry
    await ctx.db.tx((c) => requestDeletion(ctx, c, transferId, 'job', { actorKind: 'system' }));
  }
  const r = await deleteTransferContent(ctx, transferId, {});
  if (r === 'failed') throw new Error('deletion failed; will retry');
}

// ------------------------------------------------------------------ sweeps
/** Expire overdue transfers and queue deletion. Independent of per-transfer jobs. */
export async function expireSweep(ctx: AppContext) {
  const now = ctx.clock.now();
  const due = (await ctx.db.query<{ id: string }>(`SELECT id FROM transfers WHERE status IN ('active','sending') AND expires_at <= $1`, [now])).rows;
  for (const t of due) await ctx.db.tx((c) => markExpired(ctx, c, t.id));
  // Drafts that were never sent: discard after policy window (content deleted, metadata kept briefly).
  const sp = await ctx.settings.get('storage');
  const stale = (await ctx.db.query<{ id: string }>(`SELECT id FROM transfers WHERE status IN ('draft','uploading','scanning','ready') AND updated_at < ($1::timestamptz - make_interval(days => $2::int))`, [now, sp.draftTransferDays])).rows;
  for (const t of stale) {
    await ctx.db.tx(async (c) => {
      await c.query(`UPDATE transfers SET status = 'revoked', revoked_at = now() WHERE id = $1`, [t.id]);
      await audit(c, { actorKind: 'system', eventType: 'transfer.draft_discarded', transferId: t.id, details: { afterDays: sp.draftTransferDays } });
      await requestDeletion(ctx, c, t.id, 'stale_draft', { actorKind: 'system' });
    });
  }
  // A deletion left 'in_progress' for too long means the worker died mid-run: make it pending again.
  await ctx.db.query(`UPDATE transfers SET deletion_status = 'pending' WHERE deletion_status = 'in_progress' AND deletion_started_at < now() - interval '15 minutes'`);
  // Expired-but-not-yet-deleted transfers: ensure a deletion job exists (covers lost jobs after restore).
  const pending = (await ctx.db.query<{ id: string }>(`SELECT id FROM transfers WHERE deletion_status IN ('pending','failed')`)).rows;
  for (const t of pending) await enqueue(ctx.db, 'delete_transfer', { transferId: t.id, mode: 'reconcile' }, { idempotencyKey: `delete-reconcile:${t.id}:${Math.floor(now.getTime() / 600_000)}`, priority: 10 });
}

/** Reconcile storage with the database: anything on disk without a live owner is removed. */
export async function reconcileStorage(ctx: AppContext) {
  let orphans = 0;
  const released = await ctx.storage.list('released');
  const quarantine = await ctx.storage.list('quarantine');
  for (const [area, ids] of [['released', released], ['quarantine', quarantine]] as const) {
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const f = (await ctx.db.query<{ deletion_status: string; status: string; expires_at: Date; upload_status: string }>(`SELECT t.deletion_status, t.status::text, t.expires_at, f.upload_status::text FROM transfer_files f JOIN transfers t ON t.id = f.transfer_id WHERE f.id = $1`, [id])).rows[0];
      const orphan = !f || f.deletion_status !== 'none' || f.upload_status === 'abandoned' || f.status === 'expired' || f.status === 'revoked' || new Date(f.expires_at) <= ctx.clock.now() && f.status === 'active';
      if (orphan) {
        try {
          await ctx.storage.removeIfExists(ctx.storage.pathFor(area, id));
          orphans++;
        } catch (e) {
          ctx.log.error({ err: e, id }, 'reconcile: could not remove orphan');
        }
      }
    }
  }
  // Stale tus incoming files without an uploading file row
  for (const name of await ctx.storage.list('incoming')) {
    const id = name.replace(/\.json$/, '');
    const f = (await ctx.db.query<{ upload_status: string; deletion_status: string }>(`SELECT f.upload_status::text, t.deletion_status FROM transfer_files f JOIN transfers t ON t.id = f.transfer_id WHERE f.upload_id = $1`, [id])).rows[0];
    if (!f || f.upload_status === 'abandoned' || f.upload_status === 'finalised' || f.deletion_status !== 'none') {
      try {
        await ctx.storage.removeIfExists(path.join(ctx.storage.dir('incoming'), name));
        orphans++;
      } catch (e) {
        ctx.log.error({ err: e, id }, 'reconcile: could not remove stale incoming');
      }
    }
  }
  // Scratch older than 1 day
  for (const name of await ctx.storage.list('tmp')) {
    try {
      const st = await fs.stat(path.join(ctx.storage.dir('tmp'), name));
      if (Date.now() - st.mtimeMs > 86_400_000) await ctx.storage.removeIfExists(path.join(ctx.storage.dir('tmp'), name));
    } catch {
      /* ignore */
    }
  }
  if (orphans) await audit(ctx.db, { actorKind: 'system', eventType: 'storage.reconciled', details: { orphansRemoved: orphans } });
  return orphans;
}

export async function sweepAbandonedUploads(ctx: AppContext) {
  const sp = await ctx.settings.get('storage');
  const rows = (await ctx.db.query<{ id: string; transfer_id: string; size_bytes: number }>(
    `SELECT id, transfer_id, size_bytes FROM transfer_files WHERE upload_status IN ('pending','uploading') AND updated_at < now() - ($1::text || ' hours')::interval`,
    [String(sp.abandonedUploadHours)],
  )).rows;
  for (const f of rows) {
    await ctx.db.tx(async (c) => {
      await c.query(`UPDATE transfer_files SET upload_status = 'abandoned' WHERE id = $1`, [f.id]);
      await c.query(`DELETE FROM storage_reservations WHERE file_id = $1`, [f.id]);
      await c.query(`UPDATE transfers SET file_count = file_count - 1, total_bytes = total_bytes - $2 WHERE id = $1`, [f.transfer_id, f.size_bytes]);
      await audit(c, { actorKind: 'system', eventType: 'upload.abandoned', transferId: f.transfer_id, fileId: f.id, details: { reason: 'inactive' } });
      await enqueue(c, 'delete_transfer', { transferId: f.transfer_id, fileId: f.id, mode: 'file' }, { idempotencyKey: `delete-file:${f.id}`, priority: 20 });
      await recomputeTransferStatus(c, f.transfer_id);
    });
  }
  return rows.length;
}

// ------------------------------------------------------------------ outbox delivery
export async function deliverOutbox(ctx: AppContext, job: ClaimedJob) {
  const id = Number(job.payload.outboxId);
  const m = (await ctx.db.query<{ id: number; kind: TemplateKey; to_email: string; transfer_id: string | null; grant_id: string | null; data: Record<string, unknown>; status: string; attempts: number }>(`SELECT * FROM outbox_messages WHERE id = $1`, [id])).rows[0];
  if (!m || m.status === 'sent' || m.status === 'suppressed') return;
  // Recheck state before sending anything transfer-related: never send stale invitations/codes/reminders.
  if (m.transfer_id && ['transfer_available', 'verification_code', 'expiring_soon_recipient'].includes(m.kind)) {
    const t = (await ctx.db.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1`, [m.transfer_id])).rows[0];
    const g = m.grant_id ? (await ctx.db.query<{ status: string }>(`SELECT status::text FROM recipient_grants WHERE id = $1`, [m.grant_id])).rows[0] : null;
    if (!t || !isAccessible(t, ctx.clock.now()) || (g && g.status !== 'invited')) {
      await ctx.db.query(`UPDATE outbox_messages SET status = 'suppressed', last_error = 'transfer or grant no longer active at send time', data = (data - 'code' - 'link') || '{"redacted":true}'::jsonb WHERE id = $1`, [m.id]);
      await audit(ctx.db, { actorKind: 'system', eventType: 'notification.suppressed', transferId: m.transfer_id, grantId: m.grant_id, outcome: 'info', details: { kind: m.kind } });
      return;
    }
  }
  const tctx = await templateContext(ctx);
  const render = templates[m.kind] as (c: TemplateContext, d: never) => { subject: string; text: string; html: string };
  const rendered = render(tctx, m.data as never);
  await ctx.db.query(`UPDATE outbox_messages SET status = 'sending', attempts = attempts + 1 WHERE id = $1`, [m.id]);
  try {
    const res = await ctx.mailer.send({ to: m.to_email, subject: rendered.subject, text: rendered.text, html: rendered.html, headers: { 'X-SecureSend-Outbox': String(m.id), 'Auto-Submitted': 'auto-generated' } });
    await ctx.db.tx(async (c) => {
      // Scrub secrets (links carrying invitation tokens, one-time codes) once the message has left the system.
      await c.query(`UPDATE outbox_messages SET status = 'sent', sent_at = now(), provider_response = $2, data = (data - 'code' - 'link') || '{"redacted":true}'::jsonb WHERE id = $1`, [m.id, res.response]);
      if (m.kind === 'transfer_available') await audit(c, { actorKind: 'system', eventType: 'invitation.accepted_by_provider', transferId: m.transfer_id, grantId: m.grant_id, details: { note: 'SMTP accepted; inbox delivery not confirmed' } });
      else if (m.kind === 'verification_code') await audit(c, { actorKind: 'system', eventType: 'recipient.code_sent', transferId: m.transfer_id, grantId: m.grant_id, outcome: 'info' });
      await resolveAlert(c, 'smtp_failure');
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const dead = job.attempts >= job.max_attempts;
    await ctx.db.tx(async (c) => {
      await c.query(`UPDATE outbox_messages SET status = $2, last_error = $3, data = CASE WHEN $4 THEN (data - 'code' - 'link') || '{"redacted":true}'::jsonb ELSE data END WHERE id = $1`, [m.id, dead ? 'failed' : 'queued', msg.slice(0, 300), dead]);
      if (m.kind === 'transfer_available' && dead) await audit(c, { actorKind: 'system', eventType: 'invitation.failed', transferId: m.transfer_id, grantId: m.grant_id, outcome: 'failure', details: { error: msg.slice(0, 200) } });
      if (job.attempts >= 3) await raiseAlert(ctx, c, { kind: 'smtp', severity: 'warning', message: `Email delivery failing: ${msg.slice(0, 120)}`, dedupeKey: 'smtp_failure' });
    });
    throw e;
  }
}

// ------------------------------------------------------------------ expiring soon
export async function notifyExpiring(ctx: AppContext, job: ClaimedJob) {
  const t = (await ctx.db.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1`, [String(job.payload.transferId)])).rows[0];
  if (!t || !isAccessible(t, ctx.clock.now())) return;
  const np = await ctx.settings.get('notifications');
  const grants = (await ctx.db.query<{ id: string; email: string; all_files_completed_at: Date | null; token_hash: Buffer }>(`SELECT id, email, all_files_completed_at, token_hash FROM recipient_grants WHERE transfer_id = $1 AND status = 'invited'`, [t.id])).rows;
  const outstanding = grants.filter((g) => !g.all_files_completed_at);
  await ctx.db.tx(async (c) => {
    if (t.notify_prefs.expiringSoon && outstanding.length) {
      const sender = (await c.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = $1`, [t.sender_id])).rows[0]!;
      await inApp(c, { userId: sender.id, kind: 'expiringSoon', title: `"${t.title || 'Untitled transfer'}" expires soon; ${outstanding.length} recipient(s) have not downloaded everything`, transferId: t.id, dedupeKey: `expsoon:${t.id}:${new Date(t.expires_at).getTime()}` });
      await queueEmail(c, { kind: 'sender_activity', to: sender.email, toUserId: sender.id, transferId: t.id, data: { kind: 'expiringSoon', transferTitle: t.title || 'Untitled transfer', recipientEmail: null, link: new URL(`/transfers/${t.id}`, ctx.config.publicUrl).toString(), detail: `Transfer expires soon; ${outstanding.length} recipient(s) have not downloaded everything` }, dedupeKey: `expsoon:${t.id}:${new Date(t.expires_at).getTime()}` });
    }
    if (np.remindOutstandingRecipients) {
      const sender = (await c.query<{ display_name: string; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [t.sender_id])).rows[0]!;
      for (const g of outstanding) {
        // A reminder needs a fresh link: rotate the token so the reminder carries a valid URL.
        const token = randomToken(32);
        await c.query(`UPDATE recipient_grants SET token_hash = $2 WHERE id = $1`, [g.id, sha256(token)]);
        await queueEmail(c, { kind: 'expiring_soon_recipient', to: g.email, transferId: t.id, grantId: g.id, data: { senderName: sender.display_name || sender.email, link: recipientLink(ctx, token), expiresAt: new Date(t.expires_at).toISOString() }, dedupeKey: `remind:${g.id}:${new Date(t.expires_at).getTime()}` });
      }
    }
  });
}

// ------------------------------------------------------------------ audit retention / metadata purge
export async function purgeAudit(ctx: AppContext) {
  const ap = await ctx.settings.get('audit');
  const now = ctx.clock.now();
  const cutoff = new Date(now.getTime() - ap.auditRetentionDays * 86_400_000);
  const purged = (await ctx.db.query<{ audit_purge_before: number }>(`SELECT audit_purge_before($1)`, [cutoff])).rows[0]!.audit_purge_before;
  // Anonymise sensitive metadata (filenames, recipient addresses, titles) after metadata retention following deletion.
  const metaCutoff = new Date(now.getTime() - ap.metadataRetentionDays * 86_400_000);
  const rows = (await ctx.db.query<{ id: string }>(`SELECT id FROM transfers WHERE deletion_status = 'deleted' AND deletion_completed_at < $1 AND metadata_purged_at IS NULL`, [metaCutoff])).rows;
  for (const t of rows) {
    await ctx.db.tx(async (c) => {
      await c.query(`UPDATE transfer_files SET display_name = 'file', original_name = 'file', sha256 = NULL WHERE transfer_id = $1`, [t.id]);
      await c.query(`UPDATE recipient_grants SET email = ('purged-' || id::text || '@invalid'), token_hash = $2 WHERE transfer_id = $1`, [t.id, sha256(randomToken(32))]);
      await c.query(`DELETE FROM recipient_verifications v USING recipient_grants g WHERE v.grant_id = g.id AND g.transfer_id = $1`, [t.id]);
      await c.query(`UPDATE transfers SET title = '', message = '', search_text = '', metadata_purged_at = now() WHERE id = $1`, [t.id]);
      await c.query(`DELETE FROM outbox_messages WHERE transfer_id = $1`, [t.id]);
      await audit(c, { actorKind: 'system', eventType: 'metadata.purged', transferId: t.id, details: { afterDays: ap.metadataRetentionDays } });
    });
  }
  if (purged || rows.length) await audit(ctx.db, { actorKind: 'system', eventType: 'audit.purged', details: { auditRowsPurged: purged, transfersAnonymised: rows.length, cutoff: cutoff.toISOString() } });
  return { purged, anonymised: rows.length };
}

// ------------------------------------------------------------------ disk check
export async function diskCheck(ctx: AppContext) {
  const sp = await ctx.settings.get('storage');
  const d = await ctx.storage.diskUsage();
  const pct = (d.availableBytes / d.totalBytes) * 100;
  await ctx.db.tx(async (c) => {
    if (pct < sp.lowDiskCriticalPercent) await raiseAlert(ctx, c, { kind: 'disk', severity: 'critical', message: `Content storage critically low: ${pct.toFixed(1)}% free`, dedupeKey: 'disk_low' });
    else if (pct < sp.lowDiskWarnPercent) await raiseAlert(ctx, c, { kind: 'disk', severity: 'warning', message: `Content storage low: ${pct.toFixed(1)}% free`, dedupeKey: 'disk_low' });
    else await resolveAlert(c, 'disk_low');
    const ping = await ctx.scanner.ping();
    if (!ping.ok) await raiseAlert(ctx, c, { kind: 'scanner', severity: 'warning', message: `Malware scanner unreachable: ${ping.error ?? ''}`, dedupeKey: 'scanner:unavailable' });
    else await resolveAlert(c, 'scanner:unavailable');
    const overdue = (await c.query<{ n: number; oldest: Date | null }>(`SELECT count(*)::int AS n, min(deletion_requested_at) AS oldest FROM transfers WHERE deletion_status IN ('pending','failed','in_progress') AND deletion_requested_at < now() - ($1::text || ' minutes')::interval`, [String(sp.deletionTargetMinutes)])).rows[0]!;
    if (overdue.n > 0) await raiseAlert(ctx, c, { kind: 'deletion_backlog', severity: 'warning', message: `${overdue.n} transfer(s) overdue for deletion (oldest requested ${overdue.oldest?.toISOString()})`, dedupeKey: 'deletion_backlog' });
    else await resolveAlert(c, 'deletion_backlog');
  });
}
