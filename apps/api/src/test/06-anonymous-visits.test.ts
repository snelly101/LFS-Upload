import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';

const h = new Harness();
let token = '';
let transferId = '';
let fileId = '';
beforeAll(async () => {
  await h.start();
  const c = await h.login(await h.createUser('sender'));
  const s = await h.sendTransfer(c, { body: { downloadLimitPerRecipient: 1 } });
  token = s.tokens['sam@example.invalid']!;
  transferId = s.id;
  fileId = s.detail.files[0].id;
});
afterAll(() => h.stop());

describe('6. anonymous GET/HEAD/scanner visits cause no verified-view event, code send or download consumption', () => {
  it('fetching the link repeatedly (like a mail scanner) has no side effects beyond a heuristic link-seen record', async () => {
    const mailsBefore = h.mailer.sent.length;
    for (let i = 0; i < 5; i++) {
      const g = await h.api('GET', `/api/r/${token}`, undefined, '', { 'user-agent': 'Mozilla/5.0 (compatible; SafeLinks-Scanner)' });
      expect(g.status).toBe(200);
      expect(g.json.state).toBe('needs_verification');
      expect(g.json.hasSession).toBe(false);
      const hd = await h.raw(`/api/r/${token}`, { method: 'HEAD' });
      expect(hd.status).toBe(200);
    }
    await h.worker.drain();
    expect(h.mailer.sent.length).toBe(mailsBefore);
    const types = (await h.audits(transferId)).map((a) => a.event_type);
    expect(types).not.toContain('recipient.verified');
    expect(types).not.toContain('recipient.page_viewed');
    expect(types).not.toContain('recipient.code_requested');
    expect(types.filter((t) => t === 'recipient.link_requested').length).toBeGreaterThan(0);
    const seen = (await h.audits(transferId, 'recipient.link_requested'))[0]!;
    expect(seen.actor_kind).toBe('anonymous');
    expect(seen.outcome).toBe('info');
    const grant = (await h.db.query<{ first_verified_at: Date | null; downloads_used: number; first_link_seen_at: Date | null }>(`SELECT first_verified_at, downloads_used, first_link_seen_at FROM recipient_grants WHERE transfer_id = $1`, [transferId])).rows[0]!;
    expect(grant.first_verified_at).toBeNull();
    expect(grant.downloads_used).toBe(0);
    expect(grant.first_link_seen_at).not.toBeNull();
    expect((await h.db.query(`SELECT 1 FROM download_attempts`)).rowCount).toBe(0);
    expect((await h.db.query(`SELECT 1 FROM in_app_notifications`)).rowCount).toBe(0);
  });

  it('file and view endpoints without a session are 401 (GET and HEAD) and consume nothing', async () => {
    expect((await h.api('GET', `/api/r/${token}/view`)).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`)).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { method: 'HEAD' })).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/files/${fileId}`, { headers: { range: 'bytes=0-1' } })).status).toBe(401);
    expect((await h.raw(`/api/r/${token}/zip`)).status).toBe(401);
    expect((await h.db.query<{ n: number }>(`SELECT downloads_used AS n FROM recipient_grants WHERE transfer_id = $1`, [transferId])).rows[0]!.n).toBe(0);
    expect((await h.db.query(`SELECT 1 FROM download_attempts`)).rowCount).toBe(0);
  });

  it('a HEAD by the verified recipient does not consume the download allowance either', async () => {
    const v = await h.verifyRecipient(token);
    const hd = await h.raw(`/api/r/${token}/files/${fileId}`, { method: 'HEAD', cookie: v.cookie });
    expect(hd.status).toBe(200);
    // HEAD reserves an attempt (same as a GET start) but never completes it; the explicit GET resumes it.
    const g = await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie });
    expect(g.status).toBe(200);
    expect(await g.text()).toBe('hello world\n');
    const grant = (await h.db.query<{ n: number }>(`SELECT downloads_used AS n FROM recipient_grants WHERE transfer_id = $1`, [transferId])).rows[0]!;
    expect(grant.n).toBe(1);
  });
});
