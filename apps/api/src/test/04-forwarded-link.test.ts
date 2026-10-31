import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';

const h = new Harness();
let tokens: Record<string, string> = {};
let transferId = '';
beforeAll(async () => {
  await h.start();
  const u = await h.createUser('sender');
  const c = await h.login(u);
  const s = await h.sendTransfer(c, { recipients: ['alice@example.invalid', 'bob@example.invalid'] });
  tokens = s.tokens;
  transferId = s.id;
});
afterAll(() => h.stop());

describe('4. forwarding a named-recipient link to another email does not grant access', () => {
  it('each recipient gets an independent link and no other recipient is visible in the invitation', () => {
    expect(tokens['alice@example.invalid']).not.toBe(tokens['bob@example.invalid']);
    const alice = h.findMail((m) => m.to === 'alice@example.invalid')!;
    expect(alice.text).not.toContain('bob@');
    expect(alice.html).not.toContain('bob@');
  });

  it('the code is only ever sent to the original addressee; a forward-holder cannot redirect it', async () => {
    const before = h.mailer.sent.length;
    // a forwarded-link holder has no way to pass an address; the API accepts none
    const rq = await h.api('POST', `/api/r/${tokens['alice@example.invalid']}/code`, { email: 'mallory@evil.invalid' });
    expect(rq.status).toBe(200);
    await h.worker.drain(['deliver_outbox']);
    const codeMails = h.mailer.sent.slice(before).filter((m) => /verification code/i.test(m.subject));
    expect(codeMails).toHaveLength(1);
    expect(codeMails[0]!.to).toBe('alice@example.invalid');
    // public view only shows a masked hint, never the full address or any content
    const pub = await h.api('GET', `/api/r/${tokens['alice@example.invalid']}`);
    expect(pub.json.recipientHint).toMatch(/^al•+@example\.invalid$/);
    expect(JSON.stringify(pub.json)).not.toMatch(/hello\.txt|Test transfer/);
  });

  it('a code issued for one grant cannot verify another grant, and a session for A cannot open B', async () => {
    h.clock.advance(61_000);
    const a = await h.verifyRecipient(tokens['alice@example.invalid']!);
    expect(a.view.recipientEmail).toBe('alice@example.invalid');
    // reuse alice's code against bob's link
    const cross = await h.api('POST', `/api/r/${tokens['bob@example.invalid']}/verify`, { code: a.code });
    expect(cross.status).toBe(401);
    // alice's session cookie presented on bob's token path (cookie is path-scoped, but even when sent manually it is bound to the grant)
    const sessionValue = a.cookie.split('=')[1];
    const view = await h.api('GET', `/api/r/${tokens['bob@example.invalid']}/view`, undefined, `ss_recipient=${sessionValue}`);
    expect(view.status).toBe(401);
    const file = a.view.files[0].id;
    const dl = await h.raw(`/api/r/${tokens['bob@example.invalid']}/files/${file}`, { cookie: `ss_recipient=${sessionValue}` });
    expect(dl.status).toBe(401);
    // but it works on alice's own path
    const ok = await h.raw(`/api/r/${tokens['alice@example.invalid']}/files/${file}`, { cookie: a.cookie });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('hello world\n');
  });

  it('revoking one recipient leaves the other working and invalidates that recipient’s session', async () => {
    const sender = await h.createUser('sender');
    void sender;
    const grants = await h.db.query<{ id: string; email: string }>(`SELECT id, email FROM recipient_grants WHERE transfer_id = $1`, [transferId]);
    const bobGrant = grants.rows.find((g) => g.email === 'bob@example.invalid')!;
    h.clock.advance(61_000);
    const b = await h.verifyRecipient(tokens['bob@example.invalid']!);
    expect((await h.api('GET', `/api/r/${tokens['bob@example.invalid']}/view`, undefined, b.cookie)).status).toBe(200);
    const owner = (await h.db.query<{ sender_id: string }>(`SELECT sender_id FROM transfers WHERE id = $1`, [transferId])).rows[0]!.sender_id;
    const ownerUser = (await h.db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [owner])).rows[0]!;
    const oc = await h.login({ id: owner, email: ownerUser.email, role: 'sender', mfa: true });
    expect((await h.api('POST', `/api/transfers/${transferId}/grants/${bobGrant.id}/revoke`, { reason: 'wrong person' }, oc)).status).toBe(200);
    expect((await h.api('GET', `/api/r/${tokens['bob@example.invalid']}/view`, undefined, b.cookie)).status).toBe(401);
    expect((await h.api('GET', `/api/r/${tokens['bob@example.invalid']}`)).json.state).toBe('revoked');
    expect((await h.api('GET', `/api/r/${tokens['alice@example.invalid']}`)).json.state).toBe('needs_verification');
  });
});
