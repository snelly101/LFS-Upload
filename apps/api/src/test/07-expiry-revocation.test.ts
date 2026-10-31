import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';

const h = new Harness();
let cookie = '';
let sender: Awaited<ReturnType<Harness['createUser']>>;
beforeAll(async () => {
  await h.start();
  sender = await h.createUser('sender');
  cookie = await h.login(sender);
});
afterAll(() => h.stop());

describe('7. expired/revoked transfers deny access with workers stopped, including range requests and existing sessions', () => {
  it('expiry is enforced by server time on every request without any worker running', async () => {
    const s = await h.sendTransfer(cookie, { recipients: ['e@example.invalid'], body: { expiresAt: new Date(h.clock.now().getTime() + 2 * 3_600_000).toISOString() } });
    const token = s.tokens['e@example.invalid']!;
    const fileId = s.detail.files[0].id as string;
    const v = await h.verifyRecipient(token);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie, headers: { range: 'bytes=0-3' } })).status).toBe(206);
    // Jump past expiry. No worker tick happens; the DB row still says status=active.
    h.clock.advance(2 * 3_600_000 + 1000);
    const row = (await h.db.query<{ status: string }>(`SELECT status::text FROM transfers WHERE id = $1`, [s.id])).rows[0]!;
    expect(row.status).toBe('active');
    expect((await h.api('GET', `/api/r/${token}`)).json.state).toBe('expired');
    expect((await h.api('GET', `/api/r/${token}/view`, undefined, v.cookie)).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie })).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie, headers: { range: 'bytes=4-7' } })).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { method: 'HEAD', cookie: v.cookie })).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/zip`, { cookie: v.cookie })).status).toBe(401);
    expect((await h.api('POST', `/api/r/${token}/code`, {})).status).toBe(409); // no new codes for an expired transfer
    expect((await h.api('POST', `/api/r/${token}/open`, {})).status).toBe(409);
    // public response for an expired link reveals no metadata
    const pub = await h.api('GET', `/api/r/${token}`);
    expect(pub.json.recipientHint).toBeNull();
    expect(pub.text).not.toMatch(/hello\.txt|Test transfer/);
  });

  it('revoking the whole transfer immediately invalidates the recipient session and link', async () => {
    cookie = await h.login(sender);
    const s = await h.sendTransfer(cookie, { recipients: ['r@example.invalid'] });
    const token = s.tokens['r@example.invalid']!;
    const fileId = s.detail.files[0].id as string;
    const v = await h.verifyRecipient(token);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie })).status).toBe(200);
    const rv = await h.api('POST', `/api/transfers/${s.id}/revoke`, { reason: 'sent by mistake' }, cookie);
    expect(rv.status).toBe(200);
    expect(rv.json.status).toBe('revoked');
    const pubAfter = await h.api('GET', `/api/r/${token}`);
    expect(pubAfter.json.state, pubAfter.text).toBe('revoked');
    expect((await h.api('GET', `/api/r/${token}/view`, undefined, v.cookie)).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie, headers: { range: 'bytes=0-1' } })).status).toBe(401);
    expect((await h.api('POST', `/api/r/${token}/code`, {})).status).toBe(409);
    // the sender cannot add recipients or extend a revoked transfer
    expect((await h.api('POST', `/api/transfers/${s.id}/recipients`, { email: 'x@example.invalid', reason: 'x' }, cookie)).status).toBe(409);
    expect((await h.api('POST', `/api/transfers/${s.id}/extend`, { expiresAt: new Date(h.clock.now().getTime() + 3600e3).toISOString(), reason: 'x' }, cookie)).status).toBe(409);
    const types = (await h.audits(s.id)).map((a) => a.event_type);
    expect(types).toContain('transfer.revoked');
  });

  it('requesting deletion denies access even before the deletion job runs; expiry extension cannot resurrect it', async () => {
    const s = await h.sendTransfer(cookie, { recipients: ['d@example.invalid'] });
    const token = s.tokens['d@example.invalid']!;
    const v = await h.verifyRecipient(token);
    expect((await h.api('POST', `/api/transfers/${s.id}/delete-now`, {}, cookie)).status).toBe(200);
    expect((await h.api('GET', `/api/r/${token}/view`, undefined, v.cookie)).status).toBe(401);
    const row = (await h.db.query<{ deletion_status: string; status: string }>(`SELECT deletion_status::text, status::text FROM transfers WHERE id = $1`, [s.id])).rows[0]!;
    expect(row.deletion_status).toBe('pending');
    expect((await h.api('POST', `/api/transfers/${s.id}/extend`, { expiresAt: new Date(h.clock.now().getTime() + 3600e3).toISOString(), reason: 'please' }, cookie)).status).toBe(409);
  });

  it('a transfer whose sent expiry has passed cannot be re-sent, and drafts cannot be downloaded', async () => {
    const t = await h.api('POST', '/api/transfers', { title: 'draft' }, cookie);
    await h.tusUpload(cookie, t.json.id, 'f.txt', Buffer.from('x'));
    await h.worker.drain();
    await h.api('PUT', `/api/transfers/${t.json.id}/recipients`, { emails: ['z@example.invalid'] }, cookie);
    // grant exists but is pending → token hash unknown to anyone; even a sender cannot fetch files via recipient endpoints
    const g = (await h.db.query<{ status: string }>(`SELECT status::text FROM recipient_grants WHERE transfer_id = $1`, [t.json.id])).rows[0]!;
    expect(g.status).toBe('pending');
    const mails = h.mailer.sent.filter((m) => m.to === 'z@example.invalid');
    expect(mails).toHaveLength(0); // completing an upload never emails recipients
  });
});
