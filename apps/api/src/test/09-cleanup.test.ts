import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { Harness } from './harness.js';
import { expireSweep } from '../worker/handlers.js';

const h = new Harness();
let cookie = '';
beforeAll(async () => {
  await h.start();
  cookie = await h.login(await h.createUser('sender'));
});
afterAll(() => h.stop());

async function allPaths(transferId: string) {
  const files = (await h.db.query<{ id: string; upload_id: string | null }>(`SELECT id, upload_id FROM transfer_files WHERE transfer_id = $1`, [transferId])).rows;
  return files.flatMap((f) => h.ctx.storage.candidatePaths(f.id, f.upload_id));
}

describe('9. cleanup removes final data and every temporary/quarantine/archive copy; failures retry and alert', () => {
  it('after expiry every managed copy is gone, verified, and recorded as deleted', async () => {
    const s = await h.sendTransfer(cookie, { recipients: ['c@example.invalid'], files: { 'a.bin': Buffer.alloc(1024 * 1024, 1), 'b.bin': Buffer.alloc(2048, 2) } });
    const paths = await allPaths(s.id);
    const present = [];
    for (const p of paths) if (await h.ctx.storage.exists(p)) present.push(p);
    expect(present.length).toBe(2); // released copies only; incoming + quarantine were moved, not copied
    expect(present.every((p) => p.includes('/released/'))).toBe(true);
    // leave scanner/zip scratch for one of the files
    const fileId = s.detail.files[0].id as string;
    await fs.writeFile(h.ctx.storage.pathFor('tmp', `${fileId}-scan`), 'scratch');
    h.clock.advance(8 * 86_400_000);
    await expireSweep(h.ctx);
    await h.runQueuedJobsNow();
    await h.worker.drain();
    for (const p of paths) expect(await h.ctx.storage.exists(p), p).toBe(false);
    expect(await h.ctx.storage.exists(h.ctx.storage.pathFor('tmp', `${fileId}-scan`))).toBe(false);
    const t = (await h.db.query<{ status: string; deletion_status: string; deletion_requested_at: Date; deletion_started_at: Date; deletion_completed_at: Date; deletion_attempts: number }>(`SELECT status::text, deletion_status::text, deletion_requested_at, deletion_started_at, deletion_completed_at, deletion_attempts FROM transfers WHERE id = $1`, [s.id])).rows[0]!;
    expect(t.status).toBe('expired');
    expect(t.deletion_status).toBe('deleted');
    expect(t.deletion_requested_at).toBeTruthy();
    expect(t.deletion_started_at).toBeTruthy();
    expect(t.deletion_completed_at).toBeTruthy();
    expect(t.deletion_attempts).toBe(1);
    const fileStates = (await h.db.query<{ storage_state: string }>(`SELECT storage_state::text FROM transfer_files WHERE transfer_id = $1`, [s.id])).rows;
    expect(fileStates.every((f) => f.storage_state === 'deleted')).toBe(true);
    const types = (await h.audits(s.id)).map((a) => a.event_type);
    expect(types).toContain('transfer.expired');
    expect(types).toContain('deletion.requested');
    expect(types).toContain('deletion.completed');
    // the chronological receipt survives content deletion
    cookie = await h.login({ ...(await h.createUser('sender')), mfa: true });
    expect(types.length).toBeGreaterThan(5);
  });

  it('a failed deletion is recorded, alerts administrators, denies download and is retried until verified', async () => {
    const admin = await h.createUser('admin');
    const sender = await h.createUser('sender');
    cookie = await h.login(sender);
    const s = await h.sendTransfer(cookie, { recipients: ['f@example.invalid'] });
    const fileId = s.detail.files[0].id as string;
    const released = h.ctx.storage.pathFor('released', fileId);
    // Simulate an I/O failure on the released copy (e.g. a read-only or detached volume).
    const original = h.ctx.storage.removeIfExists.bind(h.ctx.storage);
    let failing = true;
    h.ctx.storage.removeIfExists = async (p: string) => {
      if (failing && p === released) throw new Error('EROFS: read-only file system');
      return original(p);
    };
    expect((await h.api('POST', `/api/transfers/${s.id}/delete-now`, {}, cookie)).status).toBe(200);
    await h.worker.drain(['delete_transfer']);
    let t = (await h.db.query<{ deletion_status: string; deletion_last_error: string; deletion_attempts: number }>(`SELECT deletion_status::text, deletion_last_error, deletion_attempts FROM transfers WHERE id = $1`, [s.id])).rows[0]!;
    expect(t.deletion_status).toBe('failed');
    expect(t.deletion_last_error).toContain('EROFS');
    expect(await h.ctx.storage.exists(released)).toBe(true);
    const alert = (await h.db.query<{ severity: string; message: string }>(`SELECT severity, message FROM operational_alerts WHERE kind = 'deletion_failed' AND resolved_at IS NULL`)).rows[0]!;
    expect(alert.severity).toBe('critical');
    const adminNotice = (await h.db.query(`SELECT 1 FROM in_app_notifications WHERE user_id = $1 AND kind = 'alert'`, [admin.id])).rowCount;
    expect(adminNotice).toBe(1);
    await h.worker.drain(['deliver_outbox']);
    expect(h.findMail((m) => m.to === admin.email && /CRITICAL/.test(m.subject))).toBeTruthy();
    // still denied for download while content physically exists
    const token = s.tokens['f@example.invalid']!;
    expect((await h.api('GET', `/api/r/${token}`)).json.state).toBe('revoked');
    // job was rescheduled for retry (not dead)
    const job = (await h.db.query<{ state: string; attempts: number }>(`SELECT state::text, attempts FROM jobs WHERE kind = 'delete_transfer' AND payload->>'transferId' = $1 AND payload->>'mode' = 'requested'`, [s.id])).rows[0]!;
    expect(job.state).toBe('queued');
    expect(job.attempts).toBe(1);
    // the sender sees the honest state
    const detail = await h.api('GET', `/api/transfers/${s.id}`, undefined, cookie);
    expect(detail.json.deletionStatus).toBe('failed');
    expect(detail.json.deletion.lastError).toContain('EROFS');
    // volume comes back
    failing = false;
    await h.runQueuedJobsNow();
    await h.worker.drain(['delete_transfer']);
    t = (await h.db.query<{ deletion_status: string; deletion_last_error: string; deletion_attempts: number }>(`SELECT deletion_status::text, deletion_last_error, deletion_attempts FROM transfers WHERE id = $1`, [s.id])).rows[0]!;
    expect(t.deletion_status).toBe('deleted');
    expect(t.deletion_attempts).toBe(2);
    expect(t.deletion_last_error).toBeNull();
    expect(await h.ctx.storage.exists(released)).toBe(false);
    expect((await h.db.query(`SELECT 1 FROM operational_alerts WHERE kind = 'deletion_failed' AND resolved_at IS NULL`)).rowCount).toBe(0);
  });

  it('removing a file from a draft and abandoning an upload both delete the partial bytes and tus metadata', async () => {
    const t = await h.api('POST', '/api/transfers', { title: 'draft' }, cookie);
    const up = await h.tusUpload(cookie, t.json.id, 'partial.bin', Buffer.alloc(3 * 1024 * 1024, 5), { stopAfterBytes: 1024 * 1024 });
    const incoming = h.ctx.storage.pathFor('incoming', up.uploadId);
    expect(await h.ctx.storage.exists(incoming)).toBe(true);
    expect(await h.ctx.storage.exists(incoming + '.json')).toBe(true);
    expect((await h.api('DELETE', `/api/transfers/${t.json.id}/files/${up.fileId}`, undefined, cookie)).status).toBe(200);
    await h.worker.drain();
    expect(await h.ctx.storage.exists(incoming)).toBe(false);
    expect(await h.ctx.storage.exists(incoming + '.json')).toBe(false);
    expect((await h.db.query(`SELECT 1 FROM storage_reservations WHERE file_id = $1`, [up.fileId])).rowCount).toBe(0);
    // tus DELETE (client cancel)
    const up2 = await h.tusUpload(cookie, t.json.id, 'cancel.bin', Buffer.alloc(2 * 1024 * 1024, 6), { stopAfterBytes: 1024 * 1024 });
    const del = await h.raw(up2.location, { method: 'DELETE', cookie, headers: { 'tus-resumable': '1.0.0' } });
    expect(del.status).toBe(204);
    await new Promise((r) => setTimeout(r, 200));
    expect(await h.ctx.storage.exists(h.ctx.storage.pathFor('incoming', up2.uploadId))).toBe(false);
    const f = (await h.db.query<{ upload_status: string }>(`SELECT upload_status::text FROM transfer_files WHERE id = $1`, [up2.fileId])).rows[0]!;
    expect(f.upload_status).toBe('abandoned');
  });
});
