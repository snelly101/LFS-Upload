import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Harness, PASSWORD } from './harness.js';
import { consumeRecoveryCode, regenerateRecoveryCodes } from '../auth/mfa.js';

const h = new Harness();
beforeAll(() => h.start());
afterAll(() => h.stop());

describe('2. local authentication cannot reach uploader/admin actions without completing MFA', () => {
  it('password-only session is blocked from transfers and admin until MFA completes', async () => {
    const admin = await h.createUser('admin');
    const c = await h.login(admin, { mfa: false });
    const me = await h.api('GET', '/api/auth/me', undefined, c);
    expect(me.json.user.authLevel).toBe('password_only');
    expect((await h.api('POST', '/api/transfers', { title: 'x' }, c)).json.error).toBe('mfa_required');
    expect((await h.api('GET', '/api/transfers', undefined, c)).status).toBe(401);
    expect((await h.api('GET', '/api/admin/settings', undefined, c)).json.error).toBe('mfa_required');
    expect((await h.api('GET', '/api/admin/users', undefined, c)).status).toBe(401);
    expect((await h.api('GET', '/api/audit', undefined, c)).status).toBe(401);
    expect((await h.api('GET', '/api/notifications', undefined, c)).status).toBe(401);
    const tus = await h.raw('/api/uploads/tus', { method: 'POST', cookie: c, headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' } });
    expect(tus.status).toBe(401);
    // wrong code keeps the session at password_only
    expect((await h.api('POST', '/api/auth/mfa/totp/verify', { code: '000000' }, c)).status).toBe(401);
    expect((await h.api('POST', '/api/transfers', { title: 'x' }, c)).status).toBe(401);
    // correct code upgrades and rotates the session id
    const ok = await h.api('POST', '/api/auth/mfa/totp/verify', { code: h.totpCode() }, c);
    expect(ok.status).toBe(200);
    expect(ok.cookie).not.toBe(c);
    expect((await h.api('POST', '/api/transfers', { title: 'x' }, c)).status).toBe(401); // old id is gone
    expect((await h.api('GET', '/api/admin/settings', undefined, ok.cookie)).status).toBe(200);
  });

  it('a user without any factor enrolled can only enrol, and becomes full only after confirming', async () => {
    const u = await h.createUser('sender', { mfa: false });
    const r = await h.api('POST', '/api/auth/login', { email: u.email, password: PASSWORD });
    expect(r.json.next).toBe('enrol_mfa');
    expect((await h.api('POST', '/api/transfers', { title: 'x' }, r.cookie)).status).toBe(401);
    const begin = await h.api('POST', '/api/auth/enrol/totp/begin', {}, r.cookie);
    expect(begin.status).toBe(200);
    expect((await h.api('POST', '/api/auth/enrol/totp/confirm', { code: '123456' }, r.cookie)).status).toBe(400);
    expect((await h.api('POST', '/api/transfers', { title: 'x' }, r.cookie)).status).toBe(401);
    const OTPAuth = await import('otpauth');
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(begin.json.secretBase32) }).generate({ timestamp: h.clock.now().getTime() });
    const confirm = await h.api('POST', '/api/auth/enrol/totp/confirm', { code }, r.cookie);
    expect(confirm.status).toBe(200);
    expect(confirm.json.recoveryCodes).toHaveLength(10);
    expect((await h.api('POST', '/api/transfers', { title: 'x' }, confirm.cookie)).status).toBe(201);
    await h.worker.drain(['deliver_outbox']);
    const notice = h.findMail((m) => m.to === u.email && /security notice/i.test(m.subject));
    expect(notice).toBeTruthy();
  });

  it('invitation acceptance yields a password-only session that must enrol MFA', async () => {
    const admin = await h.createUser('admin');
    const ac = await h.login(admin);
    const inv = await h.api('POST', '/api/admin/users/invite', { email: 'newbie@test.invalid', role: 'sender' }, ac);
    expect(inv.status).toBe(200);
    const token = inv.json.invitationLink.split('/invite/')[1];
    expect((await h.api('GET', `/api/auth/invite/${token}`)).json.email).toBe('newbie@test.invalid');
    const weak = await h.api('POST', '/api/auth/invite/accept', { token, password: 'short' });
    expect(weak.status).toBe(400);
    const acc = await h.api('POST', '/api/auth/invite/accept', { token, password: 'a-long-enough-passphrase-42' });
    expect(acc.json.next).toBe('enrol_mfa');
    expect((await h.api('POST', '/api/transfers', { title: 'x' }, acc.cookie)).json.error).toBe('mfa_required');
    expect((await h.api('POST', '/api/auth/invite/accept', { token, password: 'a-long-enough-passphrase-42' })).status).toBe(400); // single use
  });

  it('password reset never creates a session and revokes existing ones; MFA still required afterwards', async () => {
    const u = await h.createUser('sender');
    const c = await h.login(u);
    await h.api('POST', '/api/auth/password/forgot', { email: u.email });
    await h.api('POST', '/api/auth/password/forgot', { email: 'nobody@test.invalid' }); // generic, no error
    await h.worker.drain(['deliver_outbox']);
    const mail = h.findMail((m) => m.to === u.email && /password reset/i.test(m.subject))!;
    const token = mail.text.match(/token=([A-Za-z0-9_-]+)/)![1];
    const reset = await h.api('POST', '/api/auth/password/reset', { token, password: 'brand-new-passphrase-2026' });
    expect(reset.status).toBe(200);
    expect(reset.cookie).toBe(''); // no cookie set
    expect((await h.api('GET', '/api/transfers', undefined, c)).status).toBe(401); // old session revoked
    h.clock.advance(31_000);
    const login = await h.api('POST', '/api/auth/login', { email: u.email, password: 'brand-new-passphrase-2026' });
    expect(login.json.next).toBe('mfa');
    expect((await h.api('GET', '/api/transfers', undefined, login.cookie)).status).toBe(401);
  });

  it('recovery codes: only a valid unused code completes MFA, and each code works once', async () => {
    const u = await h.createUser('sender');
    const codes = await h.ctx.db.tx((c) => regenerateRecoveryCodes(c, u.id));
    const c1 = await h.login(u, { mfa: false });
    expect((await h.api('POST', '/api/auth/mfa/recovery', { code: 'aaaa-bbbb-cccc' }, c1)).status).toBe(401);
    expect((await h.api('GET', '/api/transfers', undefined, c1)).status).toBe(401);
    const ok = await h.api('POST', '/api/auth/mfa/recovery', { code: codes[0] }, c1);
    expect(ok.status).toBe(200);
    expect(ok.json.recoveryCodesRemaining).toBe(9);
    expect((await h.api('GET', '/api/transfers', undefined, ok.cookie)).status).toBe(200);
    const c2 = await h.login(u, { mfa: false });
    expect((await h.api('POST', '/api/auth/mfa/recovery', { code: codes[0] }, c2)).status).toBe(401); // reuse rejected
    expect(await h.ctx.db.tx((c) => consumeRecoveryCode(c, u.id, codes[1]!))).toBe(true);
  });

  it('TOTP codes cannot be replayed and the server-side session can be revoked', async () => {
    const u = await h.createUser('sender');
    const c = await h.login(u, { mfa: false });
    const code = h.totpCode();
    expect((await h.api('POST', '/api/auth/mfa/totp/verify', { code }, c)).status).toBe(200);
    const c2 = await h.login(u, { mfa: false }); // advances 31s → new step; reuse the OLD code
    expect((await h.api('POST', '/api/auth/mfa/totp/verify', { code }, c2)).status).toBe(401);
    const full = await h.login(u);
    const sessions = await h.api('GET', '/api/auth/sessions', undefined, full);
    expect(sessions.json.sessions.length).toBeGreaterThan(1);
    await h.api('POST', '/api/auth/sessions/revoke-others', {}, full);
    expect((await h.api('GET', '/api/auth/sessions', undefined, full)).json.sessions).toHaveLength(1);
    await h.api('POST', '/api/auth/logout', {}, full);
    expect((await h.api('GET', '/api/transfers', undefined, full)).status).toBe(401);
  });

  it('security-sensitive admin actions require recent authentication (step-up)', async () => {
    const admin = await h.createUser('admin');
    const c = await h.login(admin);
    h.clock.advance(20 * 60_000); // beyond recentAuthMinutes (15)
    const r = await h.api('PUT', '/api/admin/settings/branding', { value: { productName: 'X' }, reason: 'test' }, c);
    expect(r.json.error).toBe('recent_auth_required');
    expect((await h.api('POST', '/api/auth/step-up/totp', { code: h.totpCode() }, c)).status).toBe(200);
    expect((await h.api('PUT', '/api/admin/settings/branding', { value: { productName: 'X' }, reason: 'test' }, c)).status).toBe(200);
  });
});
