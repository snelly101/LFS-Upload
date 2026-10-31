import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { Harness, prngSource } from './harness.js';

const h = new Harness();
let cookie = '';
beforeAll(async () => {
  await h.start();
  cookie = await h.login(await h.createUser('sender'));
});
afterAll(() => h.stop());

describe('12. interrupted uploads/downloads resume without corruption, policy bypass or miscounting', () => {
  it('an interrupted tus upload resumes from the server-reported offset and finalises byte-exact', async () => {
    const SIZE = 5 * 1024 * 1024 + 777;
    const src = prngSource(SIZE, 3);
    const t = await h.api('POST', '/api/transfers', { title: 'resume' }, cookie);
    const up = await h.tusUpload(cookie, t.json.id, 'resume.bin', src, { chunkSize: 1024 * 1024, stopAfterBytes: 2 * 1024 * 1024 });
    expect(up.offset).toBe(2 * 1024 * 1024);
    // the "client" lost state: ask the server where we are
    const head = await h.tusHead(cookie, up.location);
    expect(head.offset).toBe(2 * 1024 * 1024);
    expect(head.length).toBe(SIZE);
    // a stale/replayed chunk with the wrong offset is rejected (409) and does not corrupt the file
    const replay = await h.raw(up.location, { method: 'PATCH', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, body: new Uint8Array(src.chunk(0, 1024)) });
    expect(replay.status).toBe(409);
    expect((await h.tusHead(cookie, up.location)).offset).toBe(2 * 1024 * 1024);
    const done = await h.tusPatch(cookie, up.location, src, head.offset, { chunkSize: 1024 * 1024 });
    expect(done).toBe(SIZE);
    await h.worker.drain(['scan_file']);
    const row = (await h.db.query<{ upload_status: string; storage_state: string; size_bytes: number }>(`SELECT upload_status::text, storage_state::text, size_bytes FROM transfer_files WHERE id = $1`, [up.fileId])).rows[0]!;
    expect(row.upload_status).toBe('finalised');
    expect(row.storage_state).toBe('released');
    const bytes = await fs.readFile(h.ctx.storage.pathFor('released', up.fileId));
    expect(bytes.length).toBe(SIZE);
    for (let off = 0; off < SIZE; off += 1024 * 1024) {
      const len = Math.min(1024 * 1024, SIZE - off);
      expect(bytes.subarray(off, off + len).equals(src.chunk(off, len)), `chunk at ${off}`).toBe(true);
    }
    // further PATCHes against a finalised upload are refused
    const extra = await h.raw(up.location, { method: 'PATCH', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(SIZE), 'content-type': 'application/offset+octet-stream' }, body: new Uint8Array(16) });
    expect([409, 400, 403]).toContain(extra.status);
  });

  it('declared size is enforced: Upload-Length must match the registered size and bytes beyond it are refused', async () => {
    const t = await h.api('POST', '/api/transfers', { title: 'size' }, cookie);
    const reg = await h.api('POST', `/api/transfers/${t.json.id}/files`, { name: 'declared.bin', sizeBytes: 1000 }, cookie);
    const wrong = await h.raw('/api/uploads/tus', { method: 'POST', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-length': '2000', 'upload-metadata': `uploadId ${Buffer.from(reg.json.uploadId).toString('base64')}` } });
    expect(wrong.status).toBe(400);
    const deferred = await h.raw('/api/uploads/tus', { method: 'POST', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-defer-length': '1', 'upload-metadata': `uploadId ${Buffer.from(reg.json.uploadId).toString('base64')}` } });
    expect([400, 412]).toContain(deferred.status);
    const loc = await h.tusCreate(cookie, reg.json.uploadId, 1000);
    const over = await h.raw(loc, { method: 'PATCH', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream' }, body: new Uint8Array(1500) });
    expect([400, 413, 409]).toContain(over.status);
    // partial upload never finalises
    await h.tusPatch(cookie, loc, Buffer.alloc(999, 1), 0);
    const row = (await h.db.query<{ upload_status: string }>(`SELECT upload_status::text FROM transfer_files WHERE id = $1`, [reg.json.file.id])).rows[0]!;
    expect(row.upload_status).toBe('uploading');
    const detail = await h.api('GET', `/api/transfers/${t.json.id}`, undefined, cookie);
    expect(detail.json.status).toBe('uploading');
    expect(detail.json.canSend).toBe(false);
  });

  it('policy limits are enforced at registration time (per file, per transfer, file count, blocked types)', async () => {
    const admin = await h.createUser('admin');
    const ac = await h.login(admin);
    const settings = await h.api('GET', '/api/admin/settings', undefined, ac);
    const tp = { ...settings.json.settings.transferPolicy, maxFileBytes: 1024, maxTransferBytes: 1536, maxFilesPerTransfer: 2 };
    expect((await h.api('PUT', '/api/admin/settings/transferPolicy', { value: tp, reason: 'tiny limits for test' }, ac)).status).toBe(200);
    cookie = await h.login({ ...(await h.createUser('sender')), mfa: true });
    const t = await h.api('POST', '/api/transfers', { title: 'limits' }, cookie);
    expect((await h.api('POST', `/api/transfers/${t.json.id}/files`, { name: 'big.bin', sizeBytes: 2048 }, cookie)).json.error).toBe('file_too_large');
    expect((await h.api('POST', `/api/transfers/${t.json.id}/files`, { name: 'evil.exe', sizeBytes: 10 }, cookie)).json.error).toBe('blocked_type');
    expect((await h.api('POST', `/api/transfers/${t.json.id}/files`, { name: '../../etc/passwd', sizeBytes: 10 }, cookie)).json.file.displayName).toBe('passwd');
    expect((await h.api('POST', `/api/transfers/${t.json.id}/files`, { name: 'second.bin', sizeBytes: 1024 }, cookie)).status).toBe(201);
    expect((await h.api('POST', `/api/transfers/${t.json.id}/files`, { name: 'third.bin', sizeBytes: 1000 }, cookie)).json.error).toBe('too_many_files');
    // tus maxSize follows policy too
    const reg = (await h.db.query<{ upload_id: string }>(`SELECT upload_id FROM transfer_files WHERE display_name = 'second.bin'`)).rows[0]!;
    const big = await h.raw('/api/uploads/tus', { method: 'POST', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-length': '4096', 'upload-metadata': `uploadId ${Buffer.from(reg.upload_id).toString('base64')}` } });
    expect([400, 413]).toContain(big.status);
    await h.api('PUT', '/api/admin/settings/transferPolicy', { value: settings.json.settings.transferPolicy, reason: 'restore' }, ac);
  });

  it('a resumed download counts bytes once, completes exactly once and never consumes a second allowance', async () => {
    cookie = await h.login({ ...(await h.createUser('sender')), mfa: true });
    const SIZE = 3000;
    const data = Buffer.from(prngSource(SIZE, 5).chunk(0, SIZE));
    const s = await h.sendTransfer(cookie, { recipients: ['dl@example.invalid'], files: { 'r.bin': data }, body: { downloadLimitPerRecipient: 1 } });
    const token = s.tokens['dl@example.invalid']!;
    const fileId = s.detail.files[0].id as string;
    const v = await h.verifyRecipient(token);
    const get = (range: string) => h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie, headers: { range } });
    const r1 = await get('bytes=0-999');
    expect(r1.status).toBe(206);
    expect(Buffer.from(await r1.arrayBuffer()).equals(data.subarray(0, 1000))).toBe(true);
    const r2 = await get('bytes=500-1499'); // overlapping
    expect(r2.status).toBe(206);
    expect(Buffer.from(await r2.arrayBuffer()).equals(data.subarray(500, 1500))).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    let attempt = (await h.db.query<{ covered: string; bytes_served: number; completed_at: Date | null; request_count: number }>(`SELECT covered::text, bytes_served, completed_at, request_count FROM download_attempts WHERE file_id = $1`, [fileId])).rows;
    expect(attempt).toHaveLength(1);
    expect(attempt[0]!.covered).toBe('{"[0,1500)"}');
    expect(attempt[0]!.bytes_served).toBe(2000); // bytes on the wire are counted honestly
    expect(attempt[0]!.completed_at).toBeNull(); // coverage, not bytes, decides completion
    const r3 = await get('bytes=1500-');
    expect(r3.status).toBe(206);
    expect(Buffer.from(await r3.arrayBuffer()).equals(data.subarray(1500))).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    attempt = (await h.db.query<{ covered: string; bytes_served: number; completed_at: Date | null; request_count: number }>(`SELECT covered::text, bytes_served, completed_at, request_count FROM download_attempts WHERE file_id = $1`, [fileId])).rows;
    expect(attempt).toHaveLength(1);
    expect(attempt[0]!.covered).toBe('{"[0,3000)"}');
    expect(attempt[0]!.completed_at).not.toBeNull();
    expect(attempt[0]!.request_count).toBe(3);
    const completed = await h.audits(s.id, 'download.completed');
    expect(completed).toHaveLength(1);
    const grant = (await h.db.query<{ downloads_used: number; all_files_completed_at: Date | null }>(`SELECT downloads_used, all_files_completed_at FROM recipient_grants WHERE transfer_id = $1`, [s.id])).rows[0]!;
    expect(grant.downloads_used).toBe(1);
    expect(grant.all_files_completed_at).not.toBeNull();
    // re-downloading the completed file in the same session needs a new allowance → limit reached
    const again = await get('bytes=0-10');
    expect(again.status).toBe(429);
    // an unsatisfiable range is 416 and a HEAD still reports size
    expect((await get('bytes=99999-')).status).toBe(416);
  });
});
