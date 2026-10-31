import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';

const h = new Harness();
let cookie = '';
beforeAll(async () => {
  await h.start();
  cookie = await h.login(await h.createUser('sender'));
});
afterAll(() => h.stop());

describe('14. parallel downloads cannot bypass a download-count cap; overlapping ranges do not inflate counts', () => {
  it('5 concurrent starts against a cap of 2 → exactly 2 succeed and downloads_used == 2', async () => {
    const files: Record<string, Buffer> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.bin`] = Buffer.alloc(256 * 1024, i);
    const s = await h.sendTransfer(cookie, { recipients: ['cap@example.invalid'], files, body: { downloadLimitPerRecipient: 2 } });
    const token = s.tokens['cap@example.invalid']!;
    const v = await h.verifyRecipient(token);
    expect(v.view.downloadsRemaining).toBe(2);
    const ids: string[] = s.detail.files.map((f: { id: string }) => f.id);
    const results = await Promise.all(ids.map((id) => h.raw(`/api/r/${token}/files/${id}`, { cookie: v.cookie })));
    const ok = results.filter((r) => r.status === 200);
    const limited = results.filter((r) => r.status === 429);
    expect(ok).toHaveLength(2);
    expect(limited).toHaveLength(3);
    for (const r of ok) await r.arrayBuffer();
    await new Promise((r) => setTimeout(r, 300));
    const grant = (await h.db.query<{ downloads_used: number }>(`SELECT downloads_used FROM recipient_grants WHERE transfer_id = $1`, [s.id])).rows[0]!;
    expect(grant.downloads_used).toBe(2);
    expect((await h.api('GET', `/api/r/${token}/view`, undefined, v.cookie)).json.downloadsRemaining).toBe(0);
    expect((await h.audits(s.id, 'download.completed')).length).toBe(2);
    // zip-all needs one allowance per file → refused as a whole when the cap cannot cover it
    expect((await h.raw(`/api/r/${token}/zip`, { cookie: v.cookie })).status).toBe(429);
    expect((await h.db.query<{ downloads_used: number }>(`SELECT downloads_used FROM recipient_grants WHERE transfer_id = $1`, [s.id])).rows[0]!.downloads_used).toBe(2);
  });

  it('admin maximum caps the sender’s choice (policy precedence) and the sender may only tighten', async () => {
    const admin = await h.createUser('admin');
    const ac = await h.login(admin);
    const settings = await h.api('GET', '/api/admin/settings', undefined, ac);
    await h.api('PUT', '/api/admin/settings/transferPolicy', { value: { ...settings.json.settings.transferPolicy, maxDownloadsPerRecipient: 3 }, reason: 'cap' }, ac);
    cookie = await h.login({ ...(await h.createUser('sender')), mfa: true });
    const loose = await h.api('POST', '/api/transfers', { title: 'loose', downloadLimitPerRecipient: 10 }, cookie);
    expect(loose.json.downloadLimitPerRecipient).toBe(3);
    const tight = await h.api('POST', '/api/transfers', { title: 'tight', downloadLimitPerRecipient: 1 }, cookie);
    expect(tight.json.downloadLimitPerRecipient).toBe(1);
    const none = await h.api('POST', '/api/transfers', { title: 'default' }, cookie);
    expect(none.json.downloadLimitPerRecipient).toBe(3);
    await h.api('PUT', '/api/admin/settings/transferPolicy', { value: settings.json.settings.transferPolicy, reason: 'restore' }, ac);
  });

  it('the same session hitting one file 20 times concurrently with ranges consumes a single allowance', async () => {
    const s = await h.sendTransfer(cookie, { recipients: ['many@example.invalid'], files: { 'one.bin': Buffer.alloc(200 * 1024, 7) }, body: { downloadLimitPerRecipient: 1 } });
    const token = s.tokens['many@example.invalid']!;
    const v = await h.verifyRecipient(token);
    const id = s.detail.files[0].id;
    const first = await h.raw(`/api/r/${token}/files/${id}`, { cookie: v.cookie, headers: { range: 'bytes=0-1023' } });
    expect(first.status).toBe(206);
    await first.arrayBuffer();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => h.raw(`/api/r/${token}/files/${id}`, { cookie: v.cookie, headers: { range: `bytes=${i * 5120}-${i * 5120 + 5119}` } })));
    expect(results.every((r) => r.status === 206)).toBe(true);
    for (const r of results) await r.arrayBuffer();
    await new Promise((r) => setTimeout(r, 300));
    const grant = (await h.db.query<{ downloads_used: number }>(`SELECT downloads_used FROM recipient_grants WHERE transfer_id = $1`, [s.id])).rows[0]!;
    expect(grant.downloads_used).toBe(1);
    const attempts = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM download_attempts WHERE file_id = $1`, [id])).rows[0]!.n;
    expect(attempts).toBe(1);
    expect((await h.audits(s.id, 'download.completed')).length).toBe(0); // 200 KiB never fully covered (20 × 5 KiB)
  });
});
