import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { Harness } from './harness.js';
import { expireSweep, reconcileStorage } from '../worker/handlers.js';

const h = new Harness();
let cookie = '';
beforeAll(async () => {
  await h.start();
  cookie = await h.login(await h.createUser('sender'));
});
afterAll(() => h.stop());

describe('10. restart/reconciliation and restored database metadata cannot resurrect expired content access', () => {
  it('a restored database row that says "active" still denies access because expiry is time-based, and the sweep re-deletes', async () => {
    const s = await h.sendTransfer(cookie, { recipients: ['x@example.invalid'] });
    const token = s.tokens['x@example.invalid']!;
    const v = await h.verifyRecipient(token);
    const fileId = s.detail.files[0].id as string;
    h.clock.advance(8 * 86_400_000);
    await expireSweep(h.ctx);
    await h.runQueuedJobsNow();
    await h.worker.drain();
    expect((await h.db.query<{ d: string }>(`SELECT deletion_status::text AS d FROM transfers WHERE id = $1`, [s.id])).rows[0]!.d).toBe('deleted');
    // Simulate restoring a database backup taken before expiry (status active, deletion none, old expires_at),
    // and even a stale content file re-appearing from a snapshot.
    await h.db.query(`UPDATE transfers SET status = 'active', deletion_status = 'none', deletion_completed_at = NULL, expired_at = NULL WHERE id = $1`, [s.id]);
    await h.db.query(`UPDATE transfer_files SET storage_state = 'released' WHERE transfer_id = $1`, [s.id]);
    await h.db.query(`UPDATE recipient_sessions SET revoked_at = NULL WHERE transfer_id = $1`, [s.id]);
    await fs.writeFile(h.ctx.storage.pathFor('released', fileId), 'hello world\n');
    expect((await h.api('GET', `/api/r/${token}`)).json.state).toBe('expired');
    expect((await h.api('GET', `/api/r/${token}/view`, undefined, v.cookie)).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie })).status).toBe(401);
    expect((await h.api('POST', `/api/r/${token}/code`, {})).status).toBe(409);
    // Worker restart path (some minutes later): sweep + reconcile clean it up again.
    h.clock.advance(15 * 60_000);
    await expireSweep(h.ctx);
    await h.runQueuedJobsNow();
    await h.worker.drain();
    expect((await h.db.query<{ d: string }>(`SELECT deletion_status::text AS d FROM transfers WHERE id = $1`, [s.id])).rows[0]!.d).toBe('deleted');
    expect(await h.ctx.storage.exists(h.ctx.storage.pathFor('released', fileId))).toBe(false);
  });

  it('reconciliation removes orphaned content, stale incoming uploads and never touches live files', async () => {
    cookie = await h.login({ ...(await h.createUser('sender')), mfa: true });
    const live = await h.sendTransfer(cookie, { recipients: ['live@example.invalid'] });
    const liveFile = h.ctx.storage.pathFor('released', live.detail.files[0].id);
    const orphan = h.ctx.storage.pathFor('released', '11111111-2222-3333-4444-555555555555');
    await fs.writeFile(orphan, 'orphan');
    const orphanQ = h.ctx.storage.pathFor('quarantine', '66666666-2222-3333-4444-555555555555');
    await fs.writeFile(orphanQ, 'orphan');
    await fs.writeFile(h.ctx.storage.pathFor('incoming', 'staleupload00000001'), 'stale');
    await fs.writeFile(h.ctx.storage.pathFor('incoming', 'staleupload00000001') + '.json', '{}');
    const removed = await reconcileStorage(h.ctx);
    expect(removed).toBeGreaterThanOrEqual(4);
    expect(await h.ctx.storage.exists(orphan)).toBe(false);
    expect(await h.ctx.storage.exists(orphanQ)).toBe(false);
    expect(await h.ctx.storage.exists(liveFile)).toBe(true);
    expect((await h.db.query(`SELECT 1 FROM audit_events WHERE event_type = 'storage.reconciled'`)).rowCount).toBe(1);
  });

  it('a lost deletion job is recreated by the periodic sweep and a crashed worker’s lock is recovered', async () => {
    const s = await h.sendTransfer(cookie, { recipients: ['lost@example.invalid'] });
    await h.db.query(`DELETE FROM jobs WHERE kind = 'delete_transfer' AND payload->>'transferId' = $1`, [s.id]);
    h.clock.advance(8 * 86_400_000);
    await expireSweep(h.ctx);
    const jobs = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind = 'delete_transfer' AND payload->>'transferId' = $1 AND state = 'queued'`, [s.id])).rows[0]!.n;
    expect(jobs).toBeGreaterThan(0);
    // simulate a worker that died mid-job
    await h.db.query(`UPDATE jobs SET state = 'running', locked_at = now() - interval '2 hours', locked_by = 'dead-worker' WHERE kind = 'delete_transfer' AND payload->>'transferId' = $1`, [s.id]);
    const { recoverStale } = await import('../lib/jobs.js');
    expect(await recoverStale(h.db, 30 * 60_000)).toBeGreaterThan(0);
    await h.runQueuedJobsNow();
    await h.worker.drain();
    expect((await h.db.query<{ d: string }>(`SELECT deletion_status::text AS d FROM transfers WHERE id = $1`, [s.id])).rows[0]!.d).toBe('deleted');
  });
});
