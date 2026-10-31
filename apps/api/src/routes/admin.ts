import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SettingsSections, type SettingsKey } from '@snelson/shared';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../context.js';
import { actor, requireAuth } from '../auth/guards.js';
import { audit, verifyChain } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { revokeAllSessions } from '../auth/sessions.js';
import { queueEmail, securityNotice } from '../services/notifications.js';
import { getOidcConfiguration, resetOidcCache } from '../auth/oidc.js';
import { SmtpMailer } from '../lib/mailer.js';
import { templates } from '../lib/templates.js';
import { templateContext } from '../worker/handlers.js';
import { queueStats } from '../lib/jobs.js';
import { orgUsage } from '../services/transfers.js';

const SECTION_KEYS = Object.keys(SettingsSections) as SettingsKey[];
const SECURITY_SENSITIVE: SettingsKey[] = ['identity', 'verification', 'transferPolicy', 'audit', 'storage'];

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: requireAuth(ctx, { roles: ['admin'] }) };
  const adminRecent = { preHandler: requireAuth(ctx, { roles: ['admin'], recent: true }) };

  // ------------------------------------------------------------ settings
  app.get('/api/admin/settings', admin, async () => {
    const all = await ctx.settings.all(true);
    const [oidcSecret, smtpSecret] = await Promise.all([ctx.settings.getSecret('oidc.clientSecret'), ctx.settings.getSecret('smtp.password')]);
    // never return secret values; only whether they are set
    all.identity.oidc.clientSecretSet = !!oidcSecret;
    all.smtp.passwordSet = !!smtpSecret;
    const policyVersionId = await ctx.settings.latestPolicyVersionId(ctx.db);
    return { settings: all, policyVersionId, scannerMaxBytes: ctx.config.CLAMD_MAX_STREAM_BYTES };
  });

  app.put('/api/admin/settings/:section', adminRecent, async (req) => {
    const { section } = z.object({ section: z.enum(SECTION_KEYS as [SettingsKey, ...SettingsKey[]]) }).parse(req.params);
    const body = z.object({ value: z.record(z.unknown()), reason: z.string().max(500).default(''), secrets: z.record(z.string()).optional() }).parse(req.body);
    if (SECURITY_SENSITIVE.includes(section) && !body.reason.trim()) throw badRequest('A reason is required for this change', 'reason_required');
    const before = await ctx.settings.get(section);
    const value = body.value as Record<string, unknown>;
    // Local-account MFA has no off switch; ensure nobody can lock everyone out by disabling both login methods.
    if (section === 'identity') {
      const v = value as { localLoginEnabled?: boolean; ssoEnabled?: boolean; ssoEnforced?: boolean; oidc?: { issuer?: string; clientId?: string } };
      if (!v.localLoginEnabled && !v.ssoEnabled) throw badRequest('At least one sign-in method must stay enabled', 'lockout');
      if (v.ssoEnforced) {
        if (!v.ssoEnabled) throw badRequest('Enable SSO before enforcing it', 'lockout');
        const tested = (await ctx.db.query(`SELECT 1 FROM audit_events WHERE event_type = 'admin.sso_test' AND outcome = 'success' AND occurred_at > now() - interval '7 days' LIMIT 1`)).rowCount;
        if (!tested) throw badRequest('Run a successful SSO test before enforcing SSO', 'sso_untested');
      }
      // Preserve secret-set flags; they are derived.
      if (v.oidc) (v.oidc as Record<string, unknown>).clientSecretSet = (before as typeof v).oidc && !!(await ctx.settings.getSecret('oidc.clientSecret'));
    }
    if (section === 'smtp') (value as { passwordSet?: boolean }).passwordSet = !!(await ctx.settings.getSecret('smtp.password'));
    const saved = await ctx.db.tx(async (c) => {
      const parsed = await ctx.settings.save(c, section, value as never, req.auth!.user.id);
      if (body.secrets) {
        if (section === 'identity' && typeof body.secrets.clientSecret === 'string') {
          await ctx.settings.setSecret(c, 'oidc.clientSecret', body.secrets.clientSecret, req.auth!.user.id);
          resetOidcCache();
        }
        if (section === 'smtp' && typeof body.secrets.password === 'string') await ctx.settings.setSecret(c, 'smtp.password', body.secrets.password, req.auth!.user.id);
      }
      const diff = Object.keys(parsed as Record<string, unknown>).filter((k) => JSON.stringify((parsed as Record<string, unknown>)[k]) !== JSON.stringify((before as Record<string, unknown>)[k]));
      let policyVersionId: number | null = null;
      if (['transferPolicy', 'verification', 'notifications'].includes(section)) policyVersionId = await ctx.settings.recordPolicyVersion(c, req.auth!.user.id, body.reason || null);
      // Security tightening applies to active transfers: verification 'required' revokes bearer sessions and upgrades transfers.
      let tightened = 0;
      if (section === 'verification' && (parsed as { mode: string }).mode === 'required' && (before as { mode: string }).mode !== 'required') {
        const r = await c.query(`UPDATE transfers SET verification_mode = 'required', effective_policy = effective_policy || '{"verificationMode":"required"}'::jsonb WHERE verification_mode = 'bearer' AND status IN ('draft','uploading','scanning','ready','active')`);
        tightened = r.rowCount ?? 0;
        await c.query(`UPDATE recipient_sessions SET revoked_at = now() WHERE mode = 'bearer' AND revoked_at IS NULL`);
      }
      // Loosening never changes existing transfers (they keep their recorded effective policy).
      await audit(c, { ...actor(req), eventType: 'config.changed', details: { section, changedKeys: diff, reason: body.reason, secretsUpdated: Object.keys(body.secrets ?? {}), policyVersionId, transfersTightened: tightened } });
      return parsed;
    });
    ctx.settings.invalidate();
    return { value: saved };
  });

  app.post('/api/admin/settings/sso/test', adminRecent, async (req) => {
    const identity = await ctx.settings.get('identity');
    try {
      resetOidcCache();
      const config = await getOidcConfiguration(ctx, identity);
      const meta = config.serverMetadata();
      await audit(ctx.db, { ...actor(req), eventType: 'admin.sso_test', details: { issuer: meta.issuer, authorizationEndpoint: meta.authorization_endpoint } });
      return { ok: true, issuer: meta.issuer, authorizationEndpoint: meta.authorization_endpoint, tokenEndpoint: meta.token_endpoint, note: 'Discovery succeeded. Complete a real sign-in in a private window before enforcing SSO.' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await audit(ctx.db, { ...actor(req), eventType: 'admin.sso_test', outcome: 'failure', details: { error: message } });
      return { ok: false, error: message };
    }
  });

  app.post('/api/admin/settings/smtp/test', adminRecent, async (req) => {
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    const mailer = ctx.mailer instanceof SmtpMailer ? ctx.mailer : null;
    if (mailer) {
      const v = await mailer.verify();
      if (!v.ok) {
        await audit(ctx.db, { ...actor(req), eventType: 'admin.smtp_test', outcome: 'failure', details: { error: v.error } });
        return { ok: false, error: v.error };
      }
    }
    const rendered = templates.test_message(await templateContext(ctx), { requestedBy: req.auth!.user.email });
    try {
      const res = await ctx.mailer.send({ to, subject: rendered.subject, text: rendered.text, html: rendered.html });
      await audit(ctx.db, { ...actor(req), eventType: 'admin.smtp_test', details: { to, response: res.response } });
      return { ok: true, response: res.response };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await audit(ctx.db, { ...actor(req), eventType: 'admin.smtp_test', outcome: 'failure', details: { to, error: message } });
      return { ok: false, error: message };
    }
  });

  app.get('/api/admin/templates/:kind', admin, async (req) => {
    const { kind } = z.object({ kind: z.enum(Object.keys(templates) as [string, ...string[]]) }).parse(req.params);
    const tctx = await templateContext(ctx);
    const sample: Record<string, unknown> = {
      senderName: 'Alex Example',
      senderEmail: 'alex@example.invalid',
      link: new URL('/r/EXAMPLE-LINK', ctx.config.publicUrl).toString(),
      expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      fileCount: 3,
      totalBytes: 1.5 * 1024 ** 3,
      verificationRequired: true,
      code: '123456',
      ttlMinutes: 10,
      kind: 'firstDownload',
      transferTitle: 'Q3 board pack',
      recipientEmail: 'sam@example.invalid',
      detail: 'sam@example.invalid completed the first download from "Q3 board pack"',
      inviterName: 'Administrator',
      ttlHours: 24,
      what: 'A passkey was added to your account',
      when: new Date().toISOString(),
      severity: 'warning',
      message: 'Content storage low: 12% free',
      requestedBy: req.auth!.user.email,
    };
    const r = (templates as Record<string, (c: unknown, d: unknown) => { subject: string; text: string; html: string }>)[kind]!(tctx, sample);
    return r;
  });

  // ------------------------------------------------------------ users
  app.get('/api/admin/users', admin, async () => {
    const r = await ctx.db.query<{ id: string; email: string; display_name: string; role: string; auth_kind: string; status: string; created_at: Date; last_login_at: Date | null; quota_bytes: number | null; mfa: boolean }>(
      `SELECT u.id, u.email, u.display_name, u.role::text, u.auth_kind::text, u.status::text, u.created_at, u.last_login_at, u.quota_bytes,
              (EXISTS (SELECT 1 FROM mfa_totp t WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) OR EXISTS (SELECT 1 FROM mfa_webauthn_credentials w WHERE w.user_id = u.id)) AS mfa
         FROM users u ORDER BY u.created_at`,
    );
    return { users: r.rows.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, role: u.role, authKind: u.auth_kind, status: u.status, createdAt: u.created_at, lastLoginAt: u.last_login_at, quotaBytes: u.quota_bytes, mfaEnrolled: u.mfa })) };
  });

  app.post('/api/admin/users/invite', adminRecent, async (req) => {
    const body = z.object({ email: z.string().email().max(254), displayName: z.string().max(120).default(''), role: z.enum(['sender', 'auditor', 'admin']).default('sender') }).parse(req.body);
    const email = body.email.toLowerCase();
    const identity = await ctx.settings.get('identity');
    if (!identity.localLoginEnabled) throw badRequest('Local accounts are disabled; users sign in through SSO', 'local_disabled');
    const link = await ctx.db.tx(async (c) => {
      const exists = await c.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
      if (exists.rowCount) throw conflict('A user with that email already exists', 'duplicate');
      const u = await c.query<{ id: string }>(`INSERT INTO users(email, display_name, role, auth_kind, status) VALUES ($1,$2,$3,'local','invited') RETURNING id`, [email, body.displayName, body.role]);
      await c.query(`INSERT INTO local_credentials(user_id) VALUES ($1)`, [u.rows[0]!.id]);
      const token = randomToken(32);
      await c.query(`INSERT INTO account_tokens(user_id, kind, token_hash, expires_at) VALUES ($1, 'invite', $2, now() + interval '72 hours')`, [u.rows[0]!.id, sha256(token)]);
      const link = new URL(`/invite/${token}`, ctx.config.publicUrl).toString();
      await queueEmail(c, { kind: 'account_invite', to: email, toUserId: u.rows[0]!.id, data: { link, inviterName: req.auth!.user.display_name || req.auth!.user.email, ttlHours: 72 } });
      await audit(c, { ...actor(req), eventType: 'user.invited', targetUserId: u.rows[0]!.id, details: { email, role: body.role } });
      return link;
    });
    return { ok: true, invitationLink: ctx.config.isProd ? undefined : link };
  });

  app.patch('/api/admin/users/:id', adminRecent, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ role: z.enum(['sender', 'auditor', 'admin']).optional(), status: z.enum(['active', 'disabled']).optional(), quotaBytes: z.number().int().min(0).nullable().optional(), displayName: z.string().max(120).optional(), reason: z.string().max(500).default('') }).parse(req.body);
    await ctx.db.tx(async (c) => {
      const u = (await c.query<{ id: string; email: string; role: string; status: string }>(`SELECT id, email, role::text, status::text FROM users WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!u) throw notFound('User not found');
      if (u.id === req.auth!.user.id && (body.status === 'disabled' || (body.role && body.role !== 'admin'))) throw badRequest('You cannot disable or demote your own account', 'self');
      if (body.role && body.role !== 'admin' && u.role === 'admin') {
        const admins = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'`)).rows[0]!.n;
        if (admins <= 1) throw badRequest('At least one active administrator is required', 'last_admin');
      }
      await c.query(`UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status), quota_bytes = CASE WHEN $4::boolean THEN $5 ELSE quota_bytes END, display_name = COALESCE($6, display_name), disabled_at = CASE WHEN $3 = 'disabled' THEN now() ELSE disabled_at END WHERE id = $1`, [
        id,
        body.role ?? null,
        body.status ?? null,
        body.quotaBytes !== undefined,
        body.quotaBytes ?? null,
        body.displayName ?? null,
      ]);
      if (body.status === 'disabled') await revokeAllSessions(c, id, 'admin_disabled');
      if (body.role && body.role !== u.role) {
        await revokeAllSessions(c, id, 'role_changed');
        await audit(c, { ...actor(req), eventType: 'user.role_changed', targetUserId: id, details: { from: u.role, to: body.role, reason: body.reason } });
        await securityNotice(ctx, c, u, `Your role was changed to ${body.role}`);
      }
      if (body.status && body.status !== u.status) await audit(c, { ...actor(req), eventType: body.status === 'disabled' ? 'user.disabled' : 'user.enabled', targetUserId: id, details: { reason: body.reason } });
      if (body.quotaBytes !== undefined) await audit(c, { ...actor(req), eventType: 'user.quota_changed', targetUserId: id, details: { quotaBytes: body.quotaBytes } });
    });
    return { ok: true };
  });

  /** Admin MFA reset (lost device). User must re-enrol on next login. Audited; security notice sent. */
  app.post('/api/admin/users/:id/reset-mfa', adminRecent, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body);
    await ctx.db.tx(async (c) => {
      const u = (await c.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = $1 AND auth_kind = 'local'`, [id])).rows[0];
      if (!u) throw notFound('User not found');
      await c.query(`DELETE FROM mfa_totp WHERE user_id = $1`, [id]);
      await c.query(`DELETE FROM mfa_webauthn_credentials WHERE user_id = $1`, [id]);
      await c.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [id]);
      await revokeAllSessions(c, id, 'mfa_reset');
      await audit(c, { ...actor(req), eventType: 'user.mfa_reset', targetUserId: id, details: { reason } });
      await securityNotice(ctx, c, u, 'Your multi-factor authentication was reset by an administrator');
    });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/revoke-sessions', adminRecent, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ctx.db.tx(async (c) => {
      await revokeAllSessions(c, id, 'admin_revoked');
      await audit(c, { ...actor(req), eventType: 'user.sessions_revoked', targetUserId: id });
    });
    return { ok: true };
  });

  // ------------------------------------------------------------ system health
  app.get('/api/admin/health', admin, async () => {
    const disk = await ctx.storage.diskUsage();
    const usage = await orgUsage(ctx.db);
    const scanner = await ctx.scanner.ping();
    const jobs = await queueStats(ctx.db);
    const workers = (await ctx.db.query<{ worker_id: string; last_seen: Date; details: Record<string, unknown> }>(`SELECT * FROM worker_heartbeats WHERE last_seen > now() - interval '1 day' ORDER BY last_seen DESC`)).rows;
    const deletion = (await ctx.db.query<{ pending: number; failed: number; oldest: Date | null; completed24h: number; avgSeconds: number | null }>(
      `SELECT (SELECT count(*)::int FROM transfers WHERE deletion_status IN ('pending','in_progress')) AS pending,
              (SELECT count(*)::int FROM transfers WHERE deletion_status = 'failed') AS failed,
              (SELECT min(deletion_requested_at) FROM transfers WHERE deletion_status IN ('pending','in_progress','failed')) AS oldest,
              (SELECT count(*)::int FROM transfers WHERE deletion_completed_at > now() - interval '24 hours') AS "completed24h",
              (SELECT avg(EXTRACT(EPOCH FROM (deletion_completed_at - deletion_requested_at)))::float FROM transfers WHERE deletion_completed_at > now() - interval '7 days') AS "avgSeconds"`,
    )).rows[0]!;
    const scans = (await ctx.db.query<{ pending: number; failed: number }>(`SELECT (SELECT count(*)::int FROM transfer_files WHERE scan_status IN ('pending','scanning') AND upload_status = 'finalised') AS pending, (SELECT count(*)::int FROM transfer_files WHERE scan_status IN ('error','unavailable','timeout') AND scanned_at > now() - interval '24 hours') AS failed`)).rows[0]!;
    const uploads = (await ctx.db.query<{ active: number; failed24h: number }>(`SELECT (SELECT count(*)::int FROM transfer_files WHERE upload_status = 'uploading') AS active, (SELECT count(*)::int FROM transfer_files WHERE upload_status = 'abandoned' AND updated_at > now() - interval '24 hours') AS "failed24h"`)).rows[0]!;
    const smtp = (await ctx.db.query<{ failed: number; queued: number; sent24h: number }>(`SELECT (SELECT count(*)::int FROM outbox_messages WHERE status = 'failed') AS failed, (SELECT count(*)::int FROM outbox_messages WHERE status IN ('queued','sending')) AS queued, (SELECT count(*)::int FROM outbox_messages WHERE sent_at > now() - interval '24 hours') AS "sent24h"`)).rows[0]!;
    const alerts = (await ctx.db.query(`SELECT id, kind, severity, message, created_at FROM operational_alerts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50`)).rows;
    const storageSettings = await ctx.settings.get('storage');
    const chain = await verifyChain(ctx.db, Math.max(0, ((await ctx.db.query<{ m: number | null }>(`SELECT max(id) AS m FROM audit_events`)).rows[0]!.m ?? 0) - 5000));
    return {
      now: ctx.clock.now().toISOString(),
      disk: { ...disk, usedByContent: usage.usedBytes, reserved: usage.reservedBytes, contentRoot: ctx.config.CONTENT_ROOT },
      scanner: { ...scanner, maxStreamBytes: ctx.config.CLAMD_MAX_STREAM_BYTES },
      scans,
      uploads,
      deletion: { ...deletion, targetMinutes: storageSettings.deletionTargetMinutes },
      jobs,
      workers: workers.map((w) => ({ id: w.worker_id, lastSeen: w.last_seen, alive: Date.now() - new Date(w.last_seen).getTime() < 60_000, details: w.details })),
      smtp: { ...smtp, transport: ctx.mailer.describe() },
      activeStreams: ctx.streams.size,
      alerts,
      auditChain: chain,
      backup: { lastVerifiedAt: storageSettings.lastBackupVerifiedAt, note: storageSettings.backupVerificationNote },
    };
  });

  app.post('/api/admin/alerts/:id/resolve', admin, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    await ctx.db.query(`UPDATE operational_alerts SET resolved_at = now() WHERE id = $1`, [id]);
    await audit(ctx.db, { ...actor(req), eventType: 'admin.alert_resolved', details: { alertId: id } });
    return { ok: true };
  });

  app.post('/api/admin/backup-verified', adminRecent, async (req) => {
    const { note } = z.object({ note: z.string().max(500).default('') }).parse(req.body ?? {});
    const s = await ctx.settings.get('storage');
    await ctx.db.tx(async (c) => {
      await ctx.settings.save(c, 'storage', { ...s, lastBackupVerifiedAt: ctx.clock.now().toISOString(), backupVerificationNote: note }, req.auth!.user.id);
      await audit(c, { ...actor(req), eventType: 'admin.backup_verified', details: { note } });
    });
    return { ok: true };
  });

  app.get('/api/admin/transfers', admin, async (req) => {
    // Operational metadata only: no content access.
    const q = z.object({ q: z.string().max(200).optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
    const { listTransfers } = await import('../services/transfers.js');
    return listTransfers(ctx.db, {}, { q: q.q, status: 'all', page: q.page, pageSize: 25 });
  });
}
