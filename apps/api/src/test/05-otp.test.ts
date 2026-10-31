import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness } from './harness.js';

const h = new Harness();
let cookie = '';
let sender: Awaited<ReturnType<Harness['createUser']>>;
async function freshToken(email: string) {
  const s = await h.sendTransfer(cookie, { recipients: [email] });
  return s.tokens[email]!;
}
async function requestCode(token: string) {
  const before = h.mailer.sent.length;
  const r = await h.api('POST', `/api/r/${token}/code`, {});
  await h.worker.drain(['deliver_outbox']);
  const mail = h.mailer.sent.slice(before).find((m) => /verification code/i.test(m.subject));
  return { status: r.status, json: r.json, code: mail?.text.match(/code is: (\d+)/)?.[1] };
}
beforeAll(async () => {
  await h.start();
  sender = await h.createUser('sender');
  cookie = await h.login(sender);
});
afterAll(() => h.stop());

describe('5. OTP expiry, replay, attempt limits, resend invalidation and atomic consumption', () => {
  it('two concurrent verifications of the same code: exactly one succeeds', async () => {
    const t = await freshToken('race@example.invalid');
    const { code } = await requestCode(t);
    expect(code).toBeTruthy();
    const results = await Promise.all(Array.from({ length: 4 }, () => h.api('POST', `/api/r/${t}/verify`, { code })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(3);
  });

  it('code expires after the configured TTL (10 minutes)', async () => {
    const t = await freshToken('exp@example.invalid');
    const { code } = await requestCode(t);
    h.clock.advance(10 * 60_000 + 1000);
    expect((await h.api('POST', `/api/r/${t}/verify`, { code })).status).toBe(401);
  });

  it('a consumed code cannot be replayed', async () => {
    const t = await freshToken('replay@example.invalid');
    const { code } = await requestCode(t);
    expect((await h.api('POST', `/api/r/${t}/verify`, { code })).status).toBe(200);
    expect((await h.api('POST', `/api/r/${t}/verify`, { code })).status).toBe(401);
  });

  it('after 5 wrong attempts the code is locked, even if the right code follows', async () => {
    const t = await freshToken('lock@example.invalid');
    const { code } = await requestCode(t);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await h.api('POST', `/api/r/${t}/verify`, { code: '000000' })).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(429);
    expect((await h.api('POST', `/api/r/${t}/verify`, { code })).status).toBe(429);
    const fails = await h.db.query(`SELECT 1 FROM audit_events WHERE event_type = 'recipient.verification_failed' AND details->>'reason' = 'locked'`);
    expect(fails.rowCount).toBeGreaterThan(0);
  });

  it('resend cooldown is enforced and a resend invalidates the previous code', async () => {
    const t = await freshToken('resend@example.invalid');
    const first = await requestCode(t);
    const tooSoon = await h.api('POST', `/api/r/${t}/code`, {});
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.json.error).toBe('cooldown');
    h.clock.advance(61_000);
    const second = await requestCode(t);
    expect(second.status).toBe(200);
    expect(second.code).not.toBe(first.code);
    expect((await h.api('POST', `/api/r/${t}/verify`, { code: first.code })).status).toBe(401);
    expect((await h.api('POST', `/api/r/${t}/verify`, { code: second.code })).status).toBe(200);
  });

  it('hourly cap per grant prevents email bombing', async () => {
    const t = await freshToken('bomb@example.invalid');
    let limited = false;
    for (let i = 0; i < 10; i++) {
      h.clock.advance(61_000);
      const r = await h.api('POST', `/api/r/${t}/code`, {});
      if (r.status === 429 && r.json.error === 'rate_limited') {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it('codes are stored hashed and never in audit details', async () => {
    const rows = await h.db.query<{ code_hash: Buffer }>(`SELECT code_hash FROM recipient_verifications`);
    expect(rows.rows.every((r) => Buffer.isBuffer(r.code_hash) && r.code_hash.length === 32)).toBe(true);
    const audits = await h.db.query<{ details: string }>(`SELECT details::text FROM audit_events`);
    const allMails = h.mailer.sent.filter((m) => /verification code/i.test(m.subject)).map((m) => m.text.match(/code is: (\d+)/)![1]!);
    for (const row of audits.rows) for (const code of allMails) expect(row.details).not.toContain(code);
  });
});
