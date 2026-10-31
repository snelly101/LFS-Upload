import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { badRequest, conflict, forbidden, HttpError, unauthorised } from '../context.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { hashPassword, passwordProblems, verifyPassword } from '../auth/passwords.js';
import { cookieOptions, createSession, loadSession, revokeAllSessions, revokeSession, rotateSession, SESSION_COOKIE, type UserRow } from '../auth/sessions.js';
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  beginTotpEnrolment,
  consumeRecoveryCode,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  mfaStatus,
  regenerateRecoveryCodes,
  verifyTotp,
} from '../auth/mfa.js';
import { actor, requireAuth } from '../auth/guards.js';
import { queueEmail, securityNotice } from '../services/notifications.js';
import { beginLogin, completeLogin, OidcError, roleFromGroups } from '../auth/oidc.js';

const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;

export function currentUserView(user: UserRow, session: { auth_level: string; last_strong_auth_at: Date | null }, mfaEnrolled: boolean, recentAuthMinutes: number) {
  const until = session.last_strong_auth_at ? new Date(new Date(session.last_strong_auth_at).getTime() + recentAuthMinutes * 60_000).toISOString() : null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    authKind: user.auth_kind,
    mfaEnrolled,
    authLevel: session.auth_level,
    timeZone: user.time_zone,
    notificationPrefs: user.notification_prefs,
    recentAuthUntil: until,
  };
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const loginLimit = { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } };
  const mfaLimit = { config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } };

  app.get('/api/auth/options', async () => {
    const [identity, branding] = await Promise.all([ctx.settings.get('identity'), ctx.settings.get('branding')]);
    return {
      localLoginEnabled: identity.localLoginEnabled && !identity.ssoEnforced,
      ssoEnabled: identity.ssoEnabled && !!identity.oidc.issuer && !!identity.oidc.clientId,
      ssoLabel: identity.oidc.providerLabel,
      productName: branding.productName,
      organisationName: branding.organisationName,
      accentColour: branding.accentColour,
      logoDataUrl: branding.logoDataUrl,
      supportEmail: branding.supportEmail,
    };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.auth) return { user: null };
    const identity = await ctx.settings.get('identity');
    const mfa = await mfaStatus(ctx.db, req.auth.user.id);
    return { user: currentUserView(req.auth.user, req.auth.session, mfa.enrolled, identity.recentAuthMinutes), mfa };
  });

  // ------------------------------------------------------------ local login
  app.post('/api/auth/login', loginLimit, async (req, reply) => {
    const body = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }).parse(req.body);
    const identity = await ctx.settings.get('identity');
    if (!identity.localLoginEnabled || identity.ssoEnforced) throw forbidden('Local login is disabled');
    const email = body.email.toLowerCase();
    const generic = () => unauthorised('Incorrect email or password', 'bad_credentials');
    const row = await ctx.db.maybeOne<UserRow & { password_hash: string | null; failed_attempts: number; locked_until: Date | null; email_verified_at: Date | null }>(
      `SELECT u.*, c.password_hash, c.failed_attempts, c.locked_until, c.email_verified_at FROM users u JOIN local_credentials c ON c.user_id = u.id WHERE u.email = $1 AND u.auth_kind = 'local'`,
      [email],
    );
    const now = ctx.clock.now();
    if (!row || !row.password_hash || row.status === 'disabled' || !row.email_verified_at) {
      // burn time to keep timing similar
      await verifyPassword('$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', body.password);
      await audit(ctx.db, { ...actor(req), actorKind: 'anonymous', eventType: 'auth.login_failed', outcome: 'denied', details: { email, reason: 'unknown_or_disabled' } });
      throw generic();
    }
    if (row.locked_until && row.locked_until > now) {
      await audit(ctx.db, { ...actor(req), actorKind: 'anonymous', eventType: 'auth.login_failed', outcome: 'denied', targetUserId: row.id, details: { reason: 'locked' } });
      throw unauthorised('Too many failed attempts. Try again later.', 'locked');
    }
    const ok = await verifyPassword(row.password_hash, body.password);
    if (!ok) {
      const attempts = row.failed_attempts + 1;
      await ctx.db.query(`UPDATE local_credentials SET failed_attempts = $2, locked_until = CASE WHEN $2 >= $3 THEN $4 ELSE locked_until END WHERE user_id = $1`, [
        row.id,
        attempts,
        LOCK_AFTER,
        new Date(now.getTime() + LOCK_MINUTES * 60_000),
      ]);
      await audit(ctx.db, { ...actor(req), actorKind: 'anonymous', eventType: 'auth.login_failed', outcome: 'denied', targetUserId: row.id, details: { reason: 'bad_password', attempts } });
      throw generic();
    }
    const mfa = await mfaStatus(ctx.db, row.id);
    const result = await ctx.db.tx(async (c) => {
      await c.query(`UPDATE local_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`, [row.id]);
      const s = await createSession(ctx, c, row, { authMethod: 'local', authLevel: 'password_only', ipPrefix: req.ipPrefix, userAgent: req.headers['user-agent'] });
      await audit(c, { ...actor(req), actorKind: 'user', actorUserId: row.id, actorEmail: row.email, actorSessionId: s.session.id, eventType: 'auth.password_ok', details: { next: mfa.enrolled ? 'mfa' : 'enrol_mfa' } });
      return s;
    });
    reply.setCookie(SESSION_COOKIE, result.token, cookieOptions(ctx));
    return { next: mfa.enrolled ? 'mfa' : 'enrol_mfa', methods: { totp: mfa.totp, passkey: mfa.passkeys.length > 0, recovery: mfa.recoveryCodesRemaining > 0 } };
  });

  async function completeMfa(req: Parameters<typeof actor>[0], reply: { setCookie: (n: string, v: string, o: object) => unknown }, method: string) {
    const a = req.auth!;
    const token = await ctx.db.tx(async (c) => {
      const t = await rotateSession(ctx, c, a.session.id, { authLevel: 'full', mfaMethod: method });
      await c.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [a.user.id]);
      await audit(c, { ...actor(req), eventType: 'auth.login_ok', details: { method } });
      return t;
    });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(ctx));
  }

  app.post('/api/auth/mfa/totp/verify', { ...mfaLimit, preHandler: requireAuth(ctx, { level: 'password_only' }) }, async (req, reply) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const ok = await ctx.db.tx((c) => verifyTotp(ctx, c, req.auth!.user.id, code));
    if (!ok) {
      await audit(ctx.db, { ...actor(req), eventType: 'auth.mfa_failed', outcome: 'denied', details: { method: 'totp' } });
      throw unauthorised('Incorrect code', 'bad_code');
    }
    await completeMfa(req, reply, 'totp');
    return { ok: true };
  });

  app.post('/api/auth/mfa/passkey/options', { ...mfaLimit, preHandler: requireAuth(ctx, { level: 'password_only' }) }, async (req) => {
    return ctx.db.tx((c) => beginPasskeyAuthentication(ctx, c, req.auth!.user.id));
  });

  app.post('/api/auth/mfa/passkey/verify', { ...mfaLimit, preHandler: requireAuth(ctx, { level: 'password_only' }) }, async (req, reply) => {
    const { response } = z.object({ response: z.any() }).parse(req.body);
    const ok = await ctx.db.tx((c) => finishPasskeyAuthentication(ctx, c, req.auth!.user.id, response));
    if (!ok) {
      await audit(ctx.db, { ...actor(req), eventType: 'auth.mfa_failed', outcome: 'denied', details: { method: 'webauthn' } });
      throw unauthorised('Passkey could not be verified', 'bad_passkey');
    }
    await completeMfa(req, reply, 'webauthn');
    return { ok: true };
  });

  app.post('/api/auth/mfa/recovery', { ...mfaLimit, preHandler: requireAuth(ctx, { level: 'password_only' }) }, async (req, reply) => {
    const { code } = z.object({ code: z.string().min(10).max(20) }).parse(req.body);
    const ok = await ctx.db.tx(async (c) => {
      const used = await consumeRecoveryCode(c, req.auth!.user.id, code);
      if (used) {
        await audit(c, { ...actor(req), eventType: 'auth.recovery_code_used', details: {} });
        await securityNotice(ctx, c, req.auth!.user, 'A recovery code was used to sign in to your account');
      }
      return used;
    });
    if (!ok) {
      await audit(ctx.db, { ...actor(req), eventType: 'auth.mfa_failed', outcome: 'denied', details: { method: 'recovery' } });
      throw unauthorised('Incorrect recovery code', 'bad_code');
    }
    await completeMfa(req, reply, 'recovery');
    const remaining = (await mfaStatus(ctx.db, req.auth!.user.id)).recoveryCodesRemaining;
    return { ok: true, recoveryCodesRemaining: remaining };
  });

  // ------------------------------------------------------------ step-up (recent auth)
  app.post('/api/auth/step-up/totp', { ...mfaLimit, preHandler: requireAuth(ctx) }, async (req) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const ok = await ctx.db.tx((c) => verifyTotp(ctx, c, req.auth!.user.id, code));
    if (!ok) throw unauthorised('Incorrect code', 'bad_code');
    await ctx.db.query(`UPDATE sessions SET last_strong_auth_at = $2 WHERE id = $1`, [req.auth!.session.id, ctx.clock.now()]);
    await audit(ctx.db, { ...actor(req), eventType: 'auth.step_up', details: { method: 'totp' } });
    return { ok: true };
  });
  app.post('/api/auth/step-up/passkey/options', { ...mfaLimit, preHandler: requireAuth(ctx) }, async (req) => ctx.db.tx((c) => beginPasskeyAuthentication(ctx, c, req.auth!.user.id)));
  app.post('/api/auth/step-up/passkey/verify', { ...mfaLimit, preHandler: requireAuth(ctx) }, async (req) => {
    const { response } = z.object({ response: z.any() }).parse(req.body);
    const ok = await ctx.db.tx((c) => finishPasskeyAuthentication(ctx, c, req.auth!.user.id, response));
    if (!ok) throw unauthorised('Passkey could not be verified', 'bad_passkey');
    await ctx.db.query(`UPDATE sessions SET last_strong_auth_at = $2 WHERE id = $1`, [req.auth!.session.id, ctx.clock.now()]);
    await audit(ctx.db, { ...actor(req), eventType: 'auth.step_up', details: { method: 'webauthn' } });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      await ctx.db.tx(async (c) => {
        await revokeSession(c, req.auth!.session.id, 'logout');
        await audit(c, { ...actor(req), eventType: 'auth.logout' });
      });
    }
    reply.clearCookie(SESSION_COOKIE, cookieOptions(ctx));
    return { ok: true };
  });

  // ------------------------------------------------------------ enrolment
  // Allowed with a password-only session ONLY while no factor is enrolled yet; otherwise needs full + recent auth.
  const enrolGuard = async (req: Parameters<typeof actor>[0]) => {
    if (!req.auth) throw unauthorised();
    const status = await mfaStatus(ctx.db, req.auth.user.id);
    if (status.enrolled) await requireAuth(ctx, { recent: true })(req, undefined as never);
  };

  app.post('/api/auth/enrol/totp/begin', { preHandler: enrolGuard }, async (req) => {
    const branding = await ctx.settings.get('branding');
    return ctx.db.tx((c) => beginTotpEnrolment(ctx, c, req.auth!.user, branding.productName));
  });

  app.post('/api/auth/enrol/totp/confirm', { ...mfaLimit, preHandler: enrolGuard }, async (req, reply) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const before = await mfaStatus(ctx.db, req.auth!.user.id);
    const out = await ctx.db.tx(async (c) => {
      const ok = await verifyTotp(ctx, c, req.auth!.user.id, code, { confirm: true });
      if (!ok) throw badRequest('Incorrect code – check the time on your device and try again', 'bad_code');
      const recovery = before.enrolled ? null : await regenerateRecoveryCodes(c, req.auth!.user.id);
      await audit(c, { ...actor(req), eventType: 'auth.mfa_enrolled', details: { method: 'totp' } });
      await securityNotice(ctx, c, req.auth!.user, 'An authenticator app was added to your account');
      return { recoveryCodes: recovery };
    });
    if (!before.enrolled) await completeMfa(req, reply, 'totp');
    return { ok: true, ...out };
  });

  app.post('/api/auth/enrol/passkey/options', { preHandler: enrolGuard }, async (req) => {
    const branding = await ctx.settings.get('branding');
    return ctx.db.tx((c) => beginPasskeyRegistration(ctx, c, req.auth!.user, branding.productName));
  });

  app.post('/api/auth/enrol/passkey/verify', { ...mfaLimit, preHandler: enrolGuard }, async (req, reply) => {
    const { response, label } = z.object({ response: z.any(), label: z.string().max(60).default('Passkey') }).parse(req.body);
    const before = await mfaStatus(ctx.db, req.auth!.user.id);
    const out = await ctx.db.tx(async (c) => {
      await finishPasskeyRegistration(ctx, c, req.auth!.user.id, response, label);
      const recovery = before.enrolled ? null : await regenerateRecoveryCodes(c, req.auth!.user.id);
      await audit(c, { ...actor(req), eventType: 'auth.mfa_enrolled', details: { method: 'webauthn', label } });
      await securityNotice(ctx, c, req.auth!.user, 'A passkey was added to your account');
      return { recoveryCodes: recovery };
    });
    if (!before.enrolled) await completeMfa(req, reply, 'webauthn');
    return { ok: true, ...out };
  });

  app.post('/api/auth/recovery-codes/regenerate', { preHandler: requireAuth(ctx, { recent: true }) }, async (req) => {
    const codes = await ctx.db.tx(async (c) => {
      const codes = await regenerateRecoveryCodes(c, req.auth!.user.id);
      await audit(c, { ...actor(req), eventType: 'auth.recovery_codes_regenerated' });
      await securityNotice(ctx, c, req.auth!.user, 'Your recovery codes were regenerated');
      return codes;
    });
    return { recoveryCodes: codes };
  });

  app.delete('/api/auth/passkeys/:id', { preHandler: requireAuth(ctx, { recent: true }) }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ctx.db.tx(async (c) => {
      const status = await mfaStatus(c, req.auth!.user.id);
      if (!status.totp && status.passkeys.length <= 1) throw conflict('You must keep at least one second factor', 'last_factor');
      const r = await c.query(`DELETE FROM mfa_webauthn_credentials WHERE id = $1 AND user_id = $2`, [id, req.auth!.user.id]);
      if (!r.rowCount) throw badRequest('Passkey not found');
      await audit(c, { ...actor(req), eventType: 'auth.mfa_removed', details: { method: 'webauthn' } });
      await securityNotice(ctx, c, req.auth!.user, 'A passkey was removed from your account');
    });
    return { ok: true };
  });

  app.delete('/api/auth/totp', { preHandler: requireAuth(ctx, { recent: true }) }, async (req) => {
    await ctx.db.tx(async (c) => {
      const status = await mfaStatus(c, req.auth!.user.id);
      if (status.passkeys.length === 0) throw conflict('You must keep at least one second factor', 'last_factor');
      await c.query(`DELETE FROM mfa_totp WHERE user_id = $1`, [req.auth!.user.id]);
      await audit(c, { ...actor(req), eventType: 'auth.mfa_removed', details: { method: 'totp' } });
      await securityNotice(ctx, c, req.auth!.user, 'The authenticator app was removed from your account');
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ sessions
  app.get('/api/auth/sessions', { preHandler: requireAuth(ctx) }, async (req) => {
    const r = await ctx.db.query<{ id: string; created_at: Date; last_seen_at: Date; ip_prefix: string | null; user_agent: string | null; auth_method: string; mfa_method: string | null }>(
      `SELECT id, created_at, last_seen_at, ip_prefix, user_agent, auth_method, mfa_method FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now() AND idle_expires_at > now() ORDER BY last_seen_at DESC`,
      [req.auth!.user.id],
    );
    return {
      sessions: r.rows.map((s) => ({ id: s.id, current: s.id === req.auth!.session.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at, ipPrefix: s.ip_prefix, userAgent: s.user_agent, authMethod: s.auth_method, mfaMethod: s.mfa_method })),
    };
  });
  app.post('/api/auth/sessions/revoke-others', { preHandler: requireAuth(ctx) }, async (req) => {
    await ctx.db.tx(async (c) => {
      await revokeAllSessions(c, req.auth!.user.id, 'user_revoked_others', req.auth!.session.id);
      await audit(c, { ...actor(req), eventType: 'auth.sessions_revoked', details: { scope: 'others' } });
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ invitation acceptance
  app.get('/api/auth/invite/:token', { ...loginLimit }, async (req) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.params);
    const r = await ctx.db.maybeOne<{ email: string; display_name: string }>(
      `SELECT u.email, u.display_name FROM account_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.kind = 'invite' AND t.consumed_at IS NULL AND t.expires_at > now()`,
      [sha256(token)],
    );
    if (!r) throw badRequest('This invitation link is invalid or has expired', 'invalid_token');
    return { email: r.email, displayName: r.display_name };
  });

  app.post('/api/auth/invite/accept', { ...loginLimit }, async (req, reply) => {
    const body = z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(128), displayName: z.string().max(120).default('') }).parse(req.body);
    const result = await ctx.db.tx(async (c) => {
      const t = await c.query<{ id: string; user_id: string; email: string }>(
        `SELECT t.id, t.user_id, u.email FROM account_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.kind = 'invite' AND t.consumed_at IS NULL AND t.expires_at > now() FOR UPDATE`,
        [sha256(body.token)],
      );
      const row = t.rows[0];
      if (!row) throw badRequest('This invitation link is invalid or has expired', 'invalid_token');
      const problems = passwordProblems(body.password, row.email);
      if (problems.length) throw badRequest(problems.join(' '), 'weak_password', { problems });
      await c.query(`UPDATE account_tokens SET consumed_at = now() WHERE id = $1`, [row.id]);
      await c.query(`UPDATE local_credentials SET password_hash = $2, email_verified_at = now(), password_changed_at = now() WHERE user_id = $1`, [row.user_id, await hashPassword(body.password)]);
      await c.query(`UPDATE users SET status = 'active', display_name = CASE WHEN $2 <> '' THEN $2 ELSE display_name END WHERE id = $1`, [row.user_id, body.displayName.trim()]);
      const user = (await c.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [row.user_id])).rows[0]!;
      const s = await createSession(ctx, c, user, { authMethod: 'local', authLevel: 'password_only', ipPrefix: req.ipPrefix, userAgent: req.headers['user-agent'] });
      await audit(c, { ...actor(req), actorKind: 'user', actorUserId: user.id, actorEmail: user.email, actorSessionId: s.session.id, eventType: 'auth.invite_accepted' });
      return s;
    });
    reply.setCookie(SESSION_COOKIE, result.token, cookieOptions(ctx));
    return { next: 'enrol_mfa' };
  });

  // ------------------------------------------------------------ password recovery (never bypasses MFA)
  app.post('/api/auth/password/forgot', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const { email } = z.object({ email: z.string().email().max(254) }).parse(req.body);
    const user = await ctx.db.maybeOne<UserRow>(`SELECT * FROM users WHERE email = $1 AND auth_kind = 'local' AND status = 'active'`, [email.toLowerCase()]);
    if (user) {
      const token = randomToken(32);
      await ctx.db.tx(async (c) => {
        await c.query(`INSERT INTO account_tokens(user_id, kind, token_hash, expires_at) VALUES ($1, 'password_reset', $2, now() + interval '30 minutes')`, [user.id, sha256(token)]);
        await queueEmail(c, { kind: 'password_reset', to: user.email, toUserId: user.id, data: { link: new URL(`/reset-password?token=${token}`, ctx.config.publicUrl).toString(), ttlMinutes: 30 } });
        await audit(c, { ...actor(req), actorKind: 'anonymous', eventType: 'auth.password_reset_requested', targetUserId: user.id });
      });
    }
    return { ok: true, message: 'If that address has an account, a reset link has been sent.' };
  });

  app.post('/api/auth/password/reset', { ...loginLimit }, async (req) => {
    const body = z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(128) }).parse(req.body);
    await ctx.db.tx(async (c) => {
      const t = await c.query<{ id: string; user_id: string; email: string }>(
        `SELECT t.id, t.user_id, u.email FROM account_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.kind = 'password_reset' AND t.consumed_at IS NULL AND t.expires_at > now() FOR UPDATE`,
        [sha256(body.token)],
      );
      const row = t.rows[0];
      if (!row) throw badRequest('This reset link is invalid or has expired', 'invalid_token');
      const problems = passwordProblems(body.password, row.email);
      if (problems.length) throw badRequest(problems.join(' '), 'weak_password', { problems });
      await c.query(`UPDATE account_tokens SET consumed_at = now() WHERE id = $1`, [row.id]);
      await c.query(`UPDATE local_credentials SET password_hash = $2, password_changed_at = now(), failed_attempts = 0, locked_until = NULL WHERE user_id = $1`, [row.user_id, await hashPassword(body.password)]);
      await revokeAllSessions(c, row.user_id, 'password_reset');
      await audit(c, { ...actor(req), actorKind: 'user', actorUserId: row.user_id, actorEmail: row.email, eventType: 'auth.password_reset' });
      await securityNotice(ctx, c, { id: row.user_id, email: row.email }, 'Your password was reset');
    });
    // No session is created: the user signs in normally and must still complete MFA.
    return { ok: true };
  });

  app.post('/api/auth/password/change', { preHandler: requireAuth(ctx, { recent: true }) }, async (req) => {
    const body = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) }).parse(req.body);
    await ctx.db.tx(async (c) => {
      const cred = await c.query<{ password_hash: string }>(`SELECT password_hash FROM local_credentials WHERE user_id = $1 FOR UPDATE`, [req.auth!.user.id]);
      if (!cred.rows[0] || !(await verifyPassword(cred.rows[0].password_hash, body.currentPassword))) throw unauthorised('Current password is incorrect', 'bad_credentials');
      const problems = passwordProblems(body.newPassword, req.auth!.user.email);
      if (problems.length) throw badRequest(problems.join(' '), 'weak_password', { problems });
      await c.query(`UPDATE local_credentials SET password_hash = $2, password_changed_at = now() WHERE user_id = $1`, [req.auth!.user.id, await hashPassword(body.newPassword)]);
      await revokeAllSessions(c, req.auth!.user.id, 'password_changed', req.auth!.session.id);
      await audit(c, { ...actor(req), eventType: 'auth.password_changed' });
      await securityNotice(ctx, c, req.auth!.user, 'Your password was changed');
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ SSO (OIDC)
  app.get('/api/auth/sso/start', async (req, reply) => {
    const identity = await ctx.settings.get('identity');
    if (!identity.ssoEnabled) throw forbidden('SSO is not enabled');
    const { url, challengeId } = await ctx.db.tx((c) => beginLogin(ctx, c, identity));
    reply.setCookie('ss_oidc', challengeId, { ...cookieOptions(ctx, 600), path: '/api/auth/sso' });
    return reply.redirect(url, 302);
  });

  app.get('/api/auth/sso/callback', async (req, reply) => {
    const identity = await ctx.settings.get('identity');
    const challengeId = (req.cookies as Record<string, string | undefined>)['ss_oidc'];
    reply.clearCookie('ss_oidc', { path: '/api/auth/sso' });
    if (!identity.ssoEnabled || !challengeId) return reply.redirect('/login?error=sso_state', 302);
    const currentUrl = new URL(req.raw.url ?? '/', ctx.config.publicUrl);
    try {
      const idp = await ctx.db.tx((c) => completeLogin(ctx, c, identity, challengeId, currentUrl));
      const result = await ctx.db.tx(async (c) => {
        const existing = await c.query<{ user_id: string }>(`SELECT user_id FROM sso_identities WHERE issuer = $1 AND subject = $2 FOR UPDATE`, [idp.issuer, idp.subject]);
        let userId: string;
        const role = roleFromGroups(idp, identity);
        if (existing.rows[0]) {
          userId = existing.rows[0].user_id;
          await c.query(`UPDATE sso_identities SET last_login_at = now(), last_claims = $3 WHERE issuer = $1 AND subject = $2`, [idp.issuer, idp.subject, JSON.stringify({ tid: idp.tenantId, groups: idp.groups.length, amr: idp.amr, acr: idp.acr })]);
          // Role is mapped from trusted group configuration on every login (deprovisioning via groups takes effect immediately).
          if (identity.oidc.adminGroupIds.length || identity.oidc.auditorGroupIds.length) {
            await c.query(`UPDATE users SET role = $2 WHERE id = $1 AND role <> $2`, [userId, role]);
          }
        } else {
          if (!idp.email) throw new OidcError('IdP did not supply an email address', 'no_email');
          const clash = await c.query(`SELECT 1 FROM users WHERE email = $1`, [idp.email]);
          if (clash.rowCount) throw new OidcError('An account with this email already exists and cannot be linked automatically. Ask an administrator.', 'email_clash');
          const u = await c.query<{ id: string }>(`INSERT INTO users(email, display_name, role, auth_kind, status) VALUES ($1,$2,$3,'sso','active') RETURNING id`, [idp.email, idp.name, role]);
          userId = u.rows[0]!.id;
          await c.query(`INSERT INTO sso_identities(user_id, issuer, subject, tenant_id, last_login_at, last_claims) VALUES ($1,$2,$3,$4,now(),$5)`, [userId, idp.issuer, idp.subject, idp.tenantId, JSON.stringify({ groups: idp.groups.length, amr: idp.amr })]);
          await audit(c, { ...actor(req), actorKind: 'system', eventType: 'user.provisioned_sso', targetUserId: userId, details: { role } });
        }
        const user = (await c.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId])).rows[0]!;
        if (user.status === 'disabled') throw new OidcError('Account disabled', 'disabled');
        await c.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
        const s = await createSession(ctx, c, user, { authMethod: 'sso', authLevel: 'full', mfaMethod: 'idp', ipPrefix: req.ipPrefix, userAgent: req.headers['user-agent'] });
        await audit(c, { ...actor(req), actorKind: 'user', actorUserId: user.id, actorEmail: user.email, actorSessionId: s.session.id, eventType: 'auth.login_ok', details: { method: 'sso', amr: idp.amr, acr: idp.acr } });
        return s;
      });
      reply.setCookie(SESSION_COOKIE, result.token, cookieOptions(ctx));
      return reply.redirect('/', 302);
    } catch (e) {
      const reason = e instanceof OidcError ? e.reason : 'error';
      await audit(ctx.db, { ...actor(req), actorKind: 'anonymous', eventType: 'auth.sso_rejected', outcome: 'denied', details: { reason, message: e instanceof Error ? e.message : String(e) } });
      ctx.log.warn({ reason }, 'SSO login rejected');
      return reply.redirect(`/login?error=sso_${reason}`, 302);
    }
  });

  app.get('/api/auth/session-check', async (req) => {
    // cheap endpoint the UI polls to detect server-side revocation
    const cookie = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    if (!cookie) return { active: false };
    const s = await loadSession(ctx, cookie);
    return { active: !!s, level: s?.session.auth_level ?? null };
  });

  // make unused import linters happy about HttpError in this module
  void HttpError;
}
