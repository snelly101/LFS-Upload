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

describe('15. notifications are idempotent, preferences work, retries are bounded, revoked/expired invitations are suppressed', () => {
  it('completing an upload emails nobody; sending queues exactly one invitation per recipient, de-duplicated', async () => {
    const t = await h.api('POST', '/api/transfers', { title: 'inv' }, cookie);
    await h.tusUpload(cookie, t.json.id, 'a.txt', Buffer.from('a'));
    await h.worker.drain();
    expect(h.mailer.sent).toHaveLength(0);
    await h.api('PUT', `/api/transfers/${t.json.id}/recipients`, { emails: ['one@example.invalid', 'two@example.invalid', 'ONE@example.invalid'] }, cookie);
    expect((await h.api('POST', `/api/transfers/${t.json.id}/send`, {}, cookie)).status).toBe(200);
    expect((await h.api('POST', `/api/transfers/${t.json.id}/send`, {}, cookie)).status).toBe(409); // immutable once sent
    await h.worker.drain();
    const invites = h.mailer.sent.filter((m) => /has sent you/.test(m.subject));
    expect(invites.map((m) => m.to).sort()).toEqual(['one@example.invalid', 'two@example.invalid']);
    const outbox = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_messages WHERE transfer_id = $1 AND kind = 'transfer_available'`, [t.json.id])).rows[0]!.n;
    expect(outbox).toBe(2);
    expect(invites[0]!.headers?.['Auto-Submitted']).toBe('auto-generated');
    const types = (await h.audits(t.json.id)).map((a) => a.event_type);
    expect(types.filter((x) => x === 'invitation.queued')).toHaveLength(2);
    expect(types.filter((x) => x === 'invitation.accepted_by_provider')).toHaveLength(2);
  });

  it('an invitation queued before revocation is suppressed, never sent, and audited', async () => {
    const t = await h.api('POST', '/api/transfers', { title: 'late' }, cookie);
    await h.tusUpload(cookie, t.json.id, 'a.txt', Buffer.from('a'));
    await h.worker.drain(['scan_file']);
    await h.api('PUT', `/api/transfers/${t.json.id}/recipients`, { emails: ['late@example.invalid'] }, cookie);
    await h.api('POST', `/api/transfers/${t.json.id}/send`, {}, cookie);
    // worker is "down": revoke before delivery
    await h.api('POST', `/api/transfers/${t.json.id}/revoke`, { reason: 'oops' }, cookie);
    await h.worker.drain();
    expect(h.mailer.sent.filter((m) => m.to === 'late@example.invalid')).toHaveLength(0);
    const row = (await h.db.query<{ status: string }>(`SELECT status::text FROM outbox_messages WHERE transfer_id = $1 AND kind = 'transfer_available'`, [t.json.id])).rows[0]!;
    expect(row.status).toBe('suppressed');
  });

  it('a reminder/expiring job for an already expired transfer sends nothing', async () => {
    const s = await h.sendTransfer(cookie, { title: 'Soon transfer', recipients: ['soon@example.invalid'], body: { expiresAt: new Date(h.clock.now().getTime() + 2 * 3_600_000).toISOString() } });
    const before = h.mailer.sent.length;
    h.clock.advance(3 * 3_600_000);
    await h.runQueuedJobsNow();
    await h.worker.drain(['notify_expiring', 'deliver_outbox']);
    // (runQueuedJobsNow also fires the still-future reminder of the earlier, still-active transfer; that one is legitimate)
    expect(h.mailer.sent.slice(before).filter((m) => /Soon transfer/.test(m.text) || m.to === 'soon@example.invalid')).toEqual([]);
    expect((await h.db.query(`SELECT 1 FROM in_app_notifications WHERE transfer_id = $1 AND kind = 'expiringSoon'`, [s.id])).rowCount).toBe(0);
  });

  it('SMTP failures are retried with bounded attempts and recorded; the invitation is eventually marked accepted by the provider', async () => {
    cookie = await h.login(sender);
    const t = await h.api('POST', '/api/transfers', { title: 'flaky' }, cookie);
    await h.tusUpload(cookie, t.json.id, 'a.txt', Buffer.from('a'));
    await h.worker.drain(['scan_file']);
    await h.api('PUT', `/api/transfers/${t.json.id}/recipients`, { emails: ['flaky@example.invalid'] }, cookie);
    await h.api('POST', `/api/transfers/${t.json.id}/send`, {}, cookie);
    h.mailer.failNext = new Error('451 4.7.1 try again later');
    await h.worker.drain(['deliver_outbox']);
    let row = (await h.db.query<{ status: string; attempts: number; last_error: string }>(`SELECT status::text, attempts, last_error FROM outbox_messages WHERE transfer_id = $1`, [t.json.id])).rows[0]!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('451');
    const job = (await h.db.query<{ state: string; attempts: number; run_at: Date }>(`SELECT state::text, attempts, run_at FROM jobs WHERE kind = 'deliver_outbox' ORDER BY id DESC LIMIT 1`)).rows[0]!;
    expect(job.state).toBe('queued');
    expect(job.run_at.getTime()).toBeGreaterThan(Date.now() - 1000); // backoff scheduled, not immediate
    await h.runQueuedJobsNow();
    await h.worker.drain(['deliver_outbox']);
    row = (await h.db.query<{ status: string; attempts: number; last_error: string }>(`SELECT status::text, attempts, last_error FROM outbox_messages WHERE transfer_id = $1`, [t.json.id])).rows[0]!;
    expect(row.status).toBe('sent');
    expect(row.attempts).toBe(2);
    expect(h.mailer.sent.filter((m) => m.to === 'flaky@example.invalid')).toHaveLength(1);
    // Repeated failures exhaust the bounded retries: mark failed + dead-letter + admin alert
    const t2 = await h.api('POST', '/api/transfers', { title: 'dead' }, cookie);
    await h.tusUpload(cookie, t2.json.id, 'a.txt', Buffer.from('a'));
    await h.worker.drain(['scan_file']);
    await h.api('PUT', `/api/transfers/${t2.json.id}/recipients`, { emails: ['dead@example.invalid'] }, cookie);
    await h.api('POST', `/api/transfers/${t2.json.id}/send`, {}, cookie);
    for (let i = 0; i < 8; i++) {
      h.mailer.failNext = new Error('550 relay refused');
      await h.runQueuedJobsNow();
      await h.worker.drain(['deliver_outbox']);
    }
    const dead = (await h.db.query<{ status: string; attempts: number }>(`SELECT status::text, attempts FROM outbox_messages WHERE transfer_id = $1`, [t2.json.id])).rows[0]!;
    expect(dead.status).toBe('failed');
    expect(dead.attempts).toBe(8);
    expect((await h.db.query(`SELECT 1 FROM jobs WHERE kind = 'deliver_outbox' AND state = 'dead'`)).rowCount).toBe(1);
    expect((await h.audits(t2.json.id, 'invitation.failed')).length).toBe(1);
    const detail = await h.api('GET', `/api/transfers/${t2.json.id}`, undefined, cookie);
    expect(detail.json.grants[0].invitationStatus).toBe('failed');
    expect((await h.db.query(`SELECT 1 FROM operational_alerts WHERE kind = 'smtp' AND resolved_at IS NULL`)).rowCount).toBe(1);
  });

  it('sender preferences control activity email; in-app notifications always arrive; every-download mails are de-duplicated', async () => {
    const quiet = await h.sendTransfer(cookie, { recipients: ['q@example.invalid'], body: { notifyPrefs: { firstVerifiedView: false, firstDownload: false, everyDownload: false } } });
    const loud = await h.sendTransfer(cookie, { recipients: ['l@example.invalid'], body: { notifyPrefs: { firstVerifiedView: true, firstDownload: true, everyDownload: true } } });
    for (const [s, email] of [[quiet, 'q@example.invalid'], [loud, 'l@example.invalid']] as const) {
      const token = s.tokens[email]!;
      const v = await h.verifyRecipient(token);
      const fileId = s.detail.files[0].id;
      for (let i = 0; i < 2; i++) {
        const r = await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie });
        await r.text();
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    await h.worker.drain(['deliver_outbox']);
    const senderMails = h.mailer.sent.filter((m) => m.to === sender.email);
    expect(senderMails.some((m) => /q@example\.invalid/.test(m.text))).toBe(false);
    const loudMails = senderMails.filter((m) => /l@example\.invalid/.test(m.text));
    const subjects = loudMails.map((m) => m.subject);
    expect(subjects.some((s) => /verified their email/.test(s))).toBe(true);
    expect(subjects.some((s) => /completed the first download/.test(s))).toBe(true);
    expect(subjects.filter((s) => /downloaded "hello\.txt"/.test(s))).toHaveLength(1); // two downloads → one mail
    expect(subjects.some((s) => /downloaded all files/.test(s))).toBe(true);
    const inApp = await h.api('GET', '/api/notifications', undefined, cookie);
    expect(inApp.json.items.some((n: { transferId: string; kind: string }) => n.transferId === quiet.id && n.kind === 'firstVerifiedView')).toBe(true);
    expect(inApp.json.unread).toBeGreaterThan(0);
    await h.api('POST', '/api/notifications/read', {}, cookie);
    expect((await h.api('GET', '/api/notifications', undefined, cookie)).json.unread).toBe(0);
  });

  it('global policy limits sender choices; locked choices fall back to the admin default', async () => {
    const admin = await h.createUser('admin');
    const ac = await h.login(admin);
    const settings = await h.api('GET', '/api/admin/settings', undefined, ac);
    const np = settings.json.settings.notifications;
    await h.api('PUT', '/api/admin/settings/notifications', { value: { ...np, senderChoices: { ...np.senderChoices, everyDownload: false }, defaults: { ...np.defaults, everyDownload: false } }, reason: 'no floods' }, ac);
    const t = await h.api('POST', '/api/transfers', { title: 'locked', notifyPrefs: { everyDownload: true, firstDownload: false } }, cookie);
    expect(t.json.notifyPrefs.everyDownload).toBe(false);
    expect(t.json.notifyPrefs.firstDownload).toBe(false);
    const prefs = await h.api('PUT', '/api/notifications/preferences', { everyDownload: true, firstDownload: false, bogus: true }, cookie);
    expect(prefs.json.preferences).toEqual({ firstDownload: false });
  });

  it('security-sensitive account changes always produce a security notice', async () => {
    const admin = await h.createUser('admin');
    const ac = await h.login(admin);
    const target = await h.createUser('sender');
    await h.api('PATCH', `/api/admin/users/${target.id}`, { role: 'auditor', reason: 'moved teams' }, ac);
    await h.api('POST', `/api/admin/users/${target.id}/reset-mfa`, { reason: 'lost phone' }, ac);
    await h.worker.drain(['deliver_outbox']);
    const notices = h.mailer.sent.filter((m) => m.to === target.email && /security notice/i.test(m.subject));
    expect(notices.map((m) => m.subject).join(' ')).toMatch(/role was changed/);
    expect(notices.map((m) => m.subject).join(' ')).toMatch(/reset by an administrator/);
    const types = (await h.db.query<{ t: string }>(`SELECT event_type AS t FROM audit_events WHERE target_user_id = $1 ORDER BY id`, [target.id])).rows.map((r) => r.t);
    expect(types).toContain('user.role_changed');
    expect(types).toContain('user.mfa_reset');
  });
});
