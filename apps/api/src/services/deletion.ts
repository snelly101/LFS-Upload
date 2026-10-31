import type { AppContext } from '../context.js';
import { audit } from '../lib/audit.js';
import { redactError } from '../lib/jobs.js';
import { raiseAlert, resolveAlert, inApp, queueEmail } from './notifications.js';
import type { TransferRow } from './transfers.js';

/**
 * Delete every managed copy of a transfer's content and verify removal before marking `deleted`.
 * Idempotent and retryable: each path is removed if present; verification stats every candidate path.
 */
export async function deleteTransferContent(ctx: AppContext, transferId: string, opts: { fileId?: string }): Promise<'deleted' | 'failed' | 'skipped'> {
  const t = (await ctx.db.query<TransferRow>(`SELECT * FROM transfers WHERE id = $1`, [transferId])).rows[0];
  if (!t) return 'skipped';
  const files = (
    await ctx.db.query<{ id: string; upload_id: string | null; storage_state: string; upload_status: string }>(
      `SELECT id, upload_id, storage_state, upload_status FROM transfer_files WHERE transfer_id = $1 ${opts.fileId ? 'AND id = $2' : ''}`,
      opts.fileId ? [transferId, opts.fileId] : [transferId],
    )
  ).rows;

  if (!opts.fileId) {
    // Whole-transfer deletion: only when requested (expired/revoked/draft discard). Never delete an active transfer's content.
    if (t.deletion_status === 'none' || t.deletion_status === 'deleted') return 'skipped';
    // Only one run at a time per transfer: concurrent jobs (expiry-scheduled, on-demand, reconcile) skip.
    const claimed = await ctx.db.query(
      `UPDATE transfers SET deletion_status = 'in_progress', deletion_started_at = now(), deletion_attempts = deletion_attempts + 1
        WHERE id = $1 AND deletion_status IN ('pending','failed') RETURNING id`,
      [t.id],
    );
    if (!claimed.rowCount) return 'skipped';
  }

  const failures: string[] = [];
  for (const f of files) {
    const paths = ctx.storage.candidatePaths(f.id, f.upload_id);
    for (const p of paths) {
      try {
        await ctx.storage.removeIfExists(p);
      } catch (e) {
        failures.push(`${p}: ${redactError(e)}`);
      }
    }
    // verify
    for (const p of paths) {
      if (await ctx.storage.exists(p)) failures.push(`${p}: still present after unlink`);
    }
    if (!failures.length) {
      await ctx.db.query(`UPDATE transfer_files SET storage_state = 'deleted' WHERE id = $1`, [f.id]);
    }
  }
  // scanner / zip scratch files for this transfer
  for (const id of await ctx.storage.list('tmp')) {
    if (files.some((f) => id.startsWith(f.id))) {
      try {
        await ctx.storage.removeIfExists(ctx.storage.pathFor('tmp', id));
      } catch (e) {
        failures.push(`tmp/${id}: ${redactError(e)}`);
      }
    }
  }

  if (opts.fileId) return failures.length ? 'failed' : 'deleted';

  if (failures.length) {
    const msg = failures.join('; ').slice(0, 500);
    await ctx.db.tx(async (c) => {
      await c.query(`UPDATE transfers SET deletion_status = 'failed', deletion_last_error = $2 WHERE id = $1`, [t.id, msg]);
      await audit(c, { actorKind: 'system', eventType: 'deletion.failed', transferId: t.id, outcome: 'failure', details: { attempts: t.deletion_attempts + 1, error: msg } });
      await raiseAlert(ctx, c, { kind: 'deletion_failed', severity: 'critical', message: `Content deletion failed for transfer ${t.id} (attempt ${t.deletion_attempts + 1})`, details: { transferId: t.id }, dedupeKey: `deletion_failed:${t.id}` });
    });
    return 'failed';
  }
  await ctx.db.tx(async (c) => {
    await c.query(`UPDATE transfers SET deletion_status = 'deleted', deletion_completed_at = now(), deletion_last_error = NULL WHERE id = $1`, [t.id]);
    await c.query(`UPDATE recipient_sessions SET revoked_at = now() WHERE transfer_id = $1 AND revoked_at IS NULL`, [t.id]);
    await audit(c, { actorKind: 'system', eventType: 'deletion.completed', transferId: t.id, details: { files: files.length, verified: true } });
    await resolveAlert(c, `deletion_failed:${t.id}`);
    if (t.notify_prefs.deletionCompleted && t.sent_at) {
      const sender = (await c.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = $1`, [t.sender_id])).rows[0];
      if (sender) {
        await inApp(c, { userId: sender.id, kind: 'deletionCompleted', title: `Content of "${t.title || 'Untitled transfer'}" has been deleted`, transferId: t.id, dedupeKey: `del:${t.id}` });
        await queueEmail(c, { kind: 'sender_activity', to: sender.email, toUserId: sender.id, transferId: t.id, data: { kind: 'deletionCompleted', transferTitle: t.title || 'Untitled transfer', recipientEmail: null, link: new URL(`/transfers/${t.id}`, ctx.config.publicUrl).toString(), detail: 'All file content for this transfer has been deleted' }, dedupeKey: `del:${t.id}` });
      }
    }
  });
  return 'deleted';
}
