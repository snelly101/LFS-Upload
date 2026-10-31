import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';
import { audit } from '../lib/audit.js';

const h = new Harness();
let cookie = '';
let token = '';
let code = '';
let transferId = '';
let recipientCookie = '';
let fileId = '';
let staffSession = '';
beforeAll(async () => {
  await h.start();
  cookie = await h.login(await h.createUser('sender'));
  staffSession = cookie.split('ss_session=')[1]!.split(';')[0]!;
  const s = await h.sendTransfer(cookie, { title: 'Confidential board pack', recipients: ['leak@example.invalid'], files: { 'secret-plans.pdf': Buffer.from('%PDF-1.4 secret') } });
  token = s.tokens['leak@example.invalid']!;
  transferId = s.id;
  fileId = s.detail.files[0].id;
  const v = await h.verifyRecipient(token);
  code = v.code;
  recipientCookie = v.cookie.split('=')[1]!;
  await (await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie })).text();
  await new Promise((r) => setTimeout(r, 200));
  await h.worker.drain();
});
afterAll(() => h.stop());

describe('17. logs, error responses, email templates and exports do not leak tokens, OTPs, content or unauthorised recipient data', () => {
  it('server logs never contain the invitation token, OTP code, staff or recipient session ids', async () => {
    // provoke a few error paths too
    await h.api('POST', `/api/r/${token}/verify`, { code: '000000' });
    await h.api('GET', `/api/r/${token}/files/${fileId}`);
    await h.api('GET', '/api/transfers/not-a-uuid', undefined, cookie);
    const logs = h.logBuffer.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(staffSession);
    expect(logs).not.toContain(recipientCookie);
    expect(logs).toContain('/api/r/[token]'); // request log redacts the token path
  });

  it('database never stores raw tokens or codes; audit details never contain them', async () => {
    // outbox rows carry links/codes only while queued; after delivery they are scrubbed
    const dump = await h.db.query<{ t: string }>(`SELECT (SELECT string_agg(details::text || coalesce(actor_email::text,''), ' ') FROM audit_events) || ' ' || (SELECT string_agg(data::text || status::text, ' ') FROM outbox_messages WHERE status <> 'queued') AS t`);
    const text = dump.rows[0]!.t;
    expect(text).not.toContain(token);
    expect(text).not.toContain(code);
    expect(text).not.toContain(staffSession);
    expect(text).not.toContain(recipientCookie);
    const auditOnly = (await h.db.query<{ t: string }>(`SELECT string_agg(details::text, ' ') AS t FROM audit_events`)).rows[0]!.t;
    expect(auditOnly).not.toContain(code);
    const grants = (await h.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM recipient_grants WHERE encode(token_hash, 'hex') = $1`, [token])).rows[0]!.n;
    expect(grants).toBe(0);
  });

  it('public link state exposes no title, filenames, message or full recipient address; errors are generic', async () => {
    const pub = await h.api('GET', `/api/r/${token}`);
    expect(pub.text).not.toMatch(/Confidential|secret-plans|leak@example\.invalid/);
    const bad = await h.api('GET', `/api/r/${'A'.repeat(43)}`);
    expect(bad.json.state).toBe('not_found');
    const malformed = await h.api('GET', `/api/r/short`);
    expect(malformed.status).toBe(400);
    expect(malformed.text).not.toMatch(/stack|\n\s+at /);
    const err500 = await h.api('POST', `/api/r/${token}/verify`, { code: 'not-digits' });
    expect(err500.status).toBe(400);
    expect(err500.json.error).toBe('validation');
    const bogus = await h.api('GET', `/api/transfers/${transferId}`, undefined, 'ss_session=' + 'x'.repeat(43));
    expect(bogus.status).toBe(401);
    expect(bogus.text).not.toContain('Confidential');
  });

  it('emails omit filenames by default and never include other recipients or codes in URLs', async () => {
    const invite = h.findMail((m) => m.to === 'leak@example.invalid' && /has sent you/.test(m.subject))!;
    expect(invite.text).not.toContain('secret-plans');
    expect(invite.html).not.toContain('secret-plans');
    expect(invite.subject).not.toContain('secret-plans');
    expect(invite.subject).not.toContain('Confidential');
    const codeMail = h.findMail((m) => /verification code/i.test(m.subject))!;
    expect(codeMail.text).toContain(code);
    expect(codeMail.html).not.toMatch(new RegExp(`https?://[^\\s"]*${code}`)); // never in a URL
    expect(codeMail.subject).not.toContain(code);
  });

  it('CSV export neutralises spreadsheet formulas and respects role scope', async () => {
    // a hostile value reaching a raw CSV cell (e.g. an IdP-supplied address or display name)
    await h.db.tx((c) => audit(c, { actorKind: 'user', actorEmail: '=HYPERLINK("http://evil.invalid","click")@evil.invalid', eventType: 'test.hostile' }));
    const auditor = await h.login(await h.createUser('auditor'));
    const csv = await h.api('GET', '/api/audit/export.csv', undefined, auditor);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(csv.headers.get('content-disposition')).toMatch(/attachment/);
    expect(csv.text).toContain(`'=HYPERLINK`);
    expect(csv.text).not.toMatch(/(^|\r\n)=HYPERLINK/);
    expect(csv.text).not.toContain(token);
    expect(csv.text).not.toContain(code);
    expect((await h.db.query(`SELECT 1 FROM audit_events WHERE event_type = 'audit.exported'`)).rowCount).toBe(1);
    // a sender's export is limited to their own transfers
    const other = await h.login(await h.createUser('sender'));
    const mine = await h.api('GET', '/api/audit/export.csv', undefined, other);
    expect(mine.text).not.toContain(transferId);
    const senderSearch = await h.api('GET', `/api/audit?transferId=${transferId}`, undefined, other);
    expect(senderSearch.json.total).toBe(0);
    const auditorSearch = await h.api('GET', `/api/audit?transferId=${transferId}`, undefined, auditor);
    expect(auditorSearch.json.total).toBeGreaterThan(5);
    // auditors lose recipient addresses when policy says so
    const admin = await h.login(await h.createUser('admin'));
    const settings = await h.api('GET', '/api/admin/settings', undefined, admin);
    await h.api('PUT', '/api/admin/settings/audit', { value: { ...settings.json.settings.audit, auditorsSeeRecipientEmails: false }, reason: 'privacy' }, admin);
    const masked = await h.api('GET', `/api/audit?transferId=${transferId}`, undefined, auditor);
    expect(masked.text).not.toContain('leak@example.invalid');
    expect((await h.api('GET', `/api/audit?recipient=leak`, undefined, auditor)).status).toBe(403);
  });

  it('download responses carry no-store, nosniff, attachment disposition and a locked-down CSP', async () => {
    h.clock.advance(61_000);
    const v = await h.verifyRecipient(token);
    const r = await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: v.cookie });
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    await r.text();
    const api = await h.api('GET', '/api/auth/options');
    expect(api.headers.get('referrer-policy')).toBe('no-referrer');
    expect(api.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(api.headers.get('x-frame-options')).toBeTruthy();
  });

  it('CSRF: state-changing calls without the custom header or from a foreign origin are refused', async () => {
    const r = await fetch(h.base + '/api/transfers', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"title":"csrf"}' });
    expect(r.status).toBe(403);
    const r2 = await fetch(h.base + '/api/transfers', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'snelson', origin: 'https://evil.invalid' }, body: '{"title":"csrf"}' });
    expect(r2.status).toBe(403);
    const list = await h.api('GET', '/api/transfers?q=csrf', undefined, cookie);
    expect(list.json.items).toHaveLength(0);
  });
});
