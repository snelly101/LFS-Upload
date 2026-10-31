import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { Harness, prngSource } from './harness.js';

const h = new Harness();
let cookie = '';
beforeAll(async () => {
  await h.start();
  cookie = await h.login(await h.createUser('sender'));
});
afterAll(() => h.stop());

const SIZE = 200 * 1024 * 1024;

describe('8. active downloads stop within the documented bound (5 s) after revocation or expiry', () => {
  it('revocation terminates an in-flight stream within 5 seconds', async () => {
    const src = prngSource(SIZE, 7);
    const s = await h.sendTransfer(cookie, { recipients: ['big@example.invalid'], files: { 'big.bin': Buffer.alloc(0) } });
    // replace the tiny file with a 200 MiB one written directly (keeps the upload step fast); the row must match on disk
    const fileId = s.detail.files[0].id as string;
    const p = h.ctx.storage.pathFor('released', fileId);
    const ws = fs.createWriteStream(p);
    for (let off = 0; off < SIZE; off += 8 * 1024 * 1024) {
      const ok = ws.write(src.chunk(off, Math.min(8 * 1024 * 1024, SIZE - off)));
      if (!ok) await new Promise<void>((r) => ws.once('drain', () => r()));
    }
    await new Promise<void>((r) => ws.end(() => r()));
    await h.db.query(`UPDATE transfer_files SET size_bytes = $2 WHERE id = $1`, [fileId, SIZE]);
    const token = s.tokens['big@example.invalid']!;
    const v = await h.verifyRecipient(token);
    const res = await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(SIZE));
    const reader = res.body!.getReader();
    let received = 0;
    // read ~1 MiB then revoke
    while (received < 1024 * 1024) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value!.length;
    }
    const t0 = Date.now();
    const rv = await h.api('POST', `/api/transfers/${s.id}/revoke`, { reason: 'stop' }, cookie);
    expect(rv.status).toBe(200);
    let ended: 'error' | 'done' | null = null;
    try {
      // keep reading slowly so the server has to push the remaining ~199 MiB
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          ended = 'done';
          break;
        }
        received += value!.length;
        await new Promise((r) => setTimeout(r, 5));
      }
    } catch {
      ended = 'error';
    }
    const elapsed = Date.now() - t0;
    expect(ended).toBe('error');
    expect(received).toBeLessThan(SIZE);
    expect(elapsed).toBeLessThan(5000);
    const audits = await h.audits(s.id, 'download.interrupted');
    expect(audits.length).toBe(1);
    expect(audits[0]!.details.reason).toBe('access_revoked');
    expect(h.ctx.streams.size).toBe(0);
    // eslint-disable-next-line no-console
    console.log(`[evidence] stream terminated ${elapsed} ms after revoke; ${received} of ${SIZE} bytes delivered`);
  });

  it('expiry (clock passing expires_at, no worker) also terminates an in-flight stream within 5 seconds', async () => {
    cookie = await h.login({ ...(await h.createUser('sender')), mfa: true });
    const s = await h.sendTransfer(cookie, { recipients: ['exp@example.invalid'], files: { 'big2.bin': Buffer.alloc(0) }, body: { expiresAt: new Date(h.clock.now().getTime() + 3_600_000).toISOString() } });
    const fileId = s.detail.files[0].id as string;
    const src = prngSource(SIZE, 9);
    const ws = fs.createWriteStream(h.ctx.storage.pathFor('released', fileId));
    for (let off = 0; off < SIZE; off += 8 * 1024 * 1024) {
      const ok = ws.write(src.chunk(off, Math.min(8 * 1024 * 1024, SIZE - off)));
      if (!ok) await new Promise<void>((r) => ws.once('drain', () => r()));
    }
    await new Promise<void>((r) => ws.end(() => r()));
    await h.db.query(`UPDATE transfer_files SET size_bytes = $2 WHERE id = $1`, [fileId, SIZE]);
    const token = s.tokens['exp@example.invalid']!;
    const v = await h.verifyRecipient(token);
    const res = await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie });
    const reader = res.body!.getReader();
    let received = 0;
    await reader.read();
    const t0 = Date.now();
    h.clock.advance(3_600_000 + 5000); // past expires_at; nothing else happens
    let ended: 'error' | 'done' | null = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          ended = 'done';
          break;
        }
        received += value!.length;
        await new Promise((r) => setTimeout(r, 5));
      }
    } catch {
      ended = 'error';
    }
    const elapsed = Date.now() - t0;
    expect(ended).toBe('error');
    expect(received).toBeLessThan(SIZE);
    expect(elapsed).toBeLessThan(5000);
    console.log(`[evidence] stream terminated ${elapsed} ms after expiry; ${received} of ${SIZE} bytes delivered`);
  });
});
