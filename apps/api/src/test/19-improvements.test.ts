import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';

process.env.MONITOR_TOKEN = 'test-monitor-token-0123456789abcdef';
const h = new Harness();
let alice = '';
let bob = '';
let admin = '';
let aliceUser: Awaited<ReturnType<Harness['createUser']>>;
beforeAll(async () => {
  await h.start();
  aliceUser = await h.createUser('sender');
  alice = await h.login(aliceUser);
  bob = await h.login(await h.createUser('sender'));
  admin = await h.login(await h.createUser('admin'));
});
afterAll(() => h.stop());

describe('19. list performance path, honest size limit, contacts, reminders, live events, status endpoint', () => {
  it('list returns recipients, completion counts and latest activity from a single page query, scoped to the sender', async () => {
    const s = await h.sendTransfer(alice, { title: 'Alpha pack', recipients: ['r1@example.invalid', 'r2@example.invalid'], files: { 'a.bin': Buffer.alloc(2048, 1) } });
    await h.sendTransfer(bob, { title: 'Bob only', recipients: ['r1@example.invalid'] });
    const v = await h.verifyRecipient(s.tokens['r1@example.invalid']!);
    const dl = await h.raw(`/api/r/${s.tokens['r1@example.invalid']}/files/${s.detail.files[0].id}`, { cookie: v.cookie });
    await dl.arrayBuffer();
    await new Promise((r) => setTimeout(r, 300));
    const list = await h.api('GET', '/api/transfers?pageSize=50', undefined, alice);
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(1);
    const row = list.json.items[0];
    expect(row.title).toBe('Alpha pack');
    expect(row.recipients.map((r: { email: string }) => r.email)).toEqual(['r1@example.invalid', 'r2@example.invalid']);
    expect(row.recipientsCompleted).toBe(1);
    expect(row.downloadsCompleted).toBe(1);
    expect(row.lastActivityType).toBeTruthy();
    // search by recipient and by title; LIKE wildcards in the query are literal
    expect((await h.api('GET', '/api/transfers?q=r2%40example', undefined, alice)).json.total).toBe(1);
    expect((await h.api('GET', '/api/transfers?q=alpha', undefined, alice)).json.total).toBe(1);
    expect((await h.api('GET', '/api/transfers?q=%25', undefined, alice)).json.total).toBe(0);
    expect((await h.api('GET', '/api/transfers?q=bob', undefined, alice)).json.total).toBe(0);
  });

  it('files larger than the scanner can check are refused before upload unless unscanned release is allowed', async () => {
    const policy = await h.api('GET', '/api/transfers/policy', undefined, alice);
    expect(policy.json.scanLimited).toBe(true);
    expect(policy.json.effectiveMaxFileBytes).toBe(policy.json.scannerMaxBytes);
    const t = await h.api('POST', '/api/transfers', { title: 'big' }, alice);
    const tooBig = await h.api('POST', `/api/transfers/${t.json.id}/files`, { name: 'huge.iso', sizeBytes: policy.json.scannerMaxBytes + 1 }, alice);
    expect(tooBig.status).toBe(400);
    expect(tooBig.json.error).toBe('file_too_large');
    expect(tooBig.json.scanLimited).toBe(true);
    expect(tooBig.json.maxFileBytes).toBe(policy.json.scannerMaxBytes);
    const ok = await h.api('POST', `/api/transfers/${t.json.id}/files`, { name: 'fits.iso', sizeBytes: policy.json.scannerMaxBytes }, alice);
    expect(ok.status).toBe(201);
    // with the explicit policy the admin limit applies again
    const settings = await h.api('GET', '/api/admin/settings', undefined, admin);
    await h.api('PUT', '/api/admin/settings/transferPolicy', { value: { ...settings.json.settings.transferPolicy, allowUnscannedOversizedRelease: true }, reason: 'test' }, admin);
    const p2 = await h.api('GET', '/api/transfers/policy', undefined, alice);
    expect(p2.json.scanLimited).toBe(false);
    expect(p2.json.effectiveMaxFileBytes).toBe(settings.json.settings.transferPolicy.maxFileBytes);
    await h.api('PUT', '/api/admin/settings/transferPolicy', { value: settings.json.settings.transferPolicy, reason: 'restore' }, admin);
  });

  it('contacts are the caller’s own past recipients only', async () => {
    const mine = await h.api('GET', '/api/contacts', undefined, alice);
    expect(mine.json.contacts.map((c: { email: string }) => c.email).sort()).toEqual(['r1@example.invalid', 'r2@example.invalid']);
    expect((await h.api('GET', '/api/contacts?q=r2', undefined, alice)).json.contacts).toHaveLength(1);
    expect((await h.api('GET', '/api/contacts?q=%25', undefined, alice)).json.contacts).toHaveLength(0);
    const theirs = await h.api('GET', '/api/contacts', undefined, bob);
    expect(theirs.json.contacts.map((c: { email: string }) => c.email)).toEqual(['r1@example.invalid']);
    expect((await h.api('GET', '/api/contacts')).status).toBe(401);
  });

  it('reminders: fresh link, bounded count and cooldown, owner only, refused once everything is downloaded', async () => {
    const s = await h.sendTransfer(alice, { title: 'Remind me', recipients: ['slow@example.invalid', 'done@example.invalid'], files: { 'x.bin': Buffer.alloc(1024, 2) } });
    const grants: { id: string; email: string }[] = s.detail.grants;
    const slow = grants.find((g) => g.email === 'slow@example.invalid')!;
    const done = grants.find((g) => g.email === 'done@example.invalid')!;
    // another sender cannot remind on someone else's transfer
    expect((await h.api('POST', `/api/transfers/${s.id}/grants/${slow.id}/remind`, {}, bob)).status).toBe(404);
    const before = h.mailer.sent.length;
    const r1 = await h.api('POST', `/api/transfers/${s.id}/grants/${slow.id}/remind`, {}, alice);
    expect(r1.status).toBe(200);
    await h.worker.drain(['deliver_outbox']);
    const mail = h.mailer.sent.slice(before).find((m) => m.to === 'slow@example.invalid');
    expect(mail).toBeTruthy();
    const newToken = mail!.text.match(/\/r\/([A-Za-z0-9_-]+)/)![1]!;
    expect(newToken).not.toBe(s.tokens['slow@example.invalid']);
    // the reminder's link works; the original link no longer resolves
    expect((await h.api('GET', `/api/r/${newToken}`)).json.state).toBe('needs_verification');
    expect((await h.api('GET', `/api/r/${s.tokens['slow@example.invalid']}`)).json.state).toBe('not_found');
    // cooldown
    const tooSoon = await h.api('POST', `/api/transfers/${s.id}/grants/${slow.id}/remind`, {}, alice);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.json.error).toBe('cooldown');
    // two more allowed an hour apart, then the limit (the staff session idles out after an hour, so sign in again)
    h.clock.advance(61 * 60_000);
    alice = await h.login(aliceUser);
    expect((await h.api('POST', `/api/transfers/${s.id}/grants/${slow.id}/remind`, {}, alice)).status).toBe(200);
    h.clock.advance(61 * 60_000);
    alice = await h.login(aliceUser);
    expect((await h.api('POST', `/api/transfers/${s.id}/grants/${slow.id}/remind`, {}, alice)).status).toBe(200);
    h.clock.advance(61 * 60_000);
    alice = await h.login(aliceUser);
    const limit = await h.api('POST', `/api/transfers/${s.id}/grants/${slow.id}/remind`, {}, alice);
    expect(limit.status).toBe(409);
    expect(limit.json.error).toBe('remind_limit');
    expect((await h.audits(s.id, 'invitation.reminder_sent')).length).toBe(3);
    // a recipient who has everything is not reminded
    const v = await h.verifyRecipient(s.tokens['done@example.invalid']!);
    await (await h.raw(`/api/r/${s.tokens['done@example.invalid']}/files/${s.detail.files[0].id}`, { cookie: v.cookie })).arrayBuffer();
    await new Promise((r) => setTimeout(r, 300));
    const already = await h.api('POST', `/api/transfers/${s.id}/grants/${done.id}/remind`, {}, alice);
    expect(already.status).toBe(409);
    expect(already.json.error).toBe('already_completed');
    // not after revocation
    await h.api('POST', `/api/transfers/${s.id}/revoke`, { reason: 'test' }, alice);
    expect((await h.api('POST', `/api/transfers/${s.id}/grants/${slow.id}/remind`, {}, alice)).json.error).toBe('not_active');
  });

  it('live events reach only the owner, carry ids only, and require a full session', async () => {
    expect((await h.raw('/api/events')).status).toBe(401);
    bob = await h.login(await h.createUser('sender'));
    const ac = new AbortController();
    const res = await h.raw('/api/events', { cookie: alice, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    let buf = '';
    const pump = (async () => {
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
      } catch {
        /* aborted */
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    const bobs = await h.api('POST', '/api/transfers', { title: 'bob live' }, bob);
    const mine = await h.api('POST', '/api/transfers', { title: 'alice live' }, alice);
    for (let i = 0; i < 40 && !buf.includes(mine.json.id); i++) await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await pump;
    expect(buf).toContain('event: ready');
    expect(buf).toContain('event: transfer');
    expect(buf).toContain(mine.json.id);
    expect(buf).not.toContain(bobs.json.id);
    expect(buf).not.toContain('alice live');
    expect(buf).not.toContain('@');
  });

  it('/statusz needs the monitoring token and reports levels only', async () => {
    expect((await h.raw('/statusz')).status).toBe(401);
    expect((await h.raw('/statusz', { headers: { authorization: 'Bearer wrong-token-wrong-token-wrong-token' } })).status).toBe(401);
    await h.db.query(`INSERT INTO worker_heartbeats(worker_id, last_seen) VALUES ('t', $1) ON CONFLICT (worker_id) DO UPDATE SET last_seen = EXCLUDED.last_seen`, [h.clock.now()]);
    const ok = await h.raw('/statusz', { headers: { authorization: `Bearer ${process.env.MONITOR_TOKEN}` } });
    const body = await ok.json();
    expect(Object.keys(body.checks).sort()).toEqual(['database', 'deletion', 'email', 'scanner', 'storage', 'worker']);
    for (const v of Object.values(body.checks)) expect(['ok', 'warn', 'fail']).toContain(v);
    expect(body.checks.database).toBe('ok');
    expect(body.checks.worker).toBe('ok');
    expect(JSON.stringify(body)).not.toMatch(/postgres|password|\/srv|@/i);
  });
});
