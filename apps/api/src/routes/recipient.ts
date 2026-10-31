import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, notFound } from '../context.js';
import { cookieOptions } from '../auth/sessions.js';
import * as R from '../services/recipients.js';
import { releasedFile, streamFile, streamZip } from '../services/downloads.js';
import { audit } from '../lib/audit.js';

/**
 * External recipient API. No admin shell, no third-party scripts, no information before authorisation.
 * All routes are keyed by the opaque per-recipient token; tokens are never logged.
 */
export async function recipientRoutes(app: FastifyInstance, ctx: AppContext) {
  const params = z.object({ token: z.string().min(40).max(50) });
  const limitLight = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  const limitCode = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } };
  const limitVerify = { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } };

  const actorFor = (req: FastifyRequest) => ({ correlationId: req.correlationId, ipPrefix: req.ipPrefix, userAgent: req.headers['user-agent'] ?? null });
  const cookieFor = (req: FastifyRequest) => (req.cookies as Record<string, string | undefined>)[R.RECIPIENT_COOKIE];

  async function lookupOr404(token: string) {
    R.assertToken(token);
    const l = await R.lookupGrant(ctx.db, token);
    return l;
  }

  /** Public state – safe to call anonymously (and by link scanners). Sends nothing, consumes nothing. */
  app.get('/api/r/:token', limitLight, async (req) => {
    const { token } = params.parse(req.params);
    const l = await lookupOr404(token);
    const [branding, verification] = await Promise.all([ctx.settings.get('branding'), ctx.settings.get('verification')]);
    const state = R.publicState(ctx, l);
    if (l && state !== 'not_found') await ctx.db.tx((c) => R.recordLinkSeen(c, l, actorFor(req)));
    const hasSession = l ? !!(await R.loadRecipientSession(ctx, ctx.db, l, cookieFor(req))) : false;
    return {
      state,
      hasSession,
      productName: branding.productName,
      organisationName: branding.organisationName,
      supportEmail: branding.supportEmail,
      accentColour: branding.accentColour,
      logoDataUrl: branding.logoDataUrl,
      recipientHint: l && (state === 'needs_verification') ? R.maskEmail(l.grant.email) : null,
      verification: state === 'needs_verification' && l ? { codeTtlSeconds: l.transfer.effective_policy.codeTtlSeconds ?? verification.codeTtlSeconds, resendCooldownSeconds: l.transfer.effective_policy.resendCooldownSeconds ?? verification.resendCooldownSeconds } : null,
    };
  });

  app.post('/api/r/:token/code', limitCode, async (req) => {
    const { token } = params.parse(req.params);
    const l = await lookupOr404(token);
    if (!l) throw notFound();
    return ctx.db.tx((c) => R.requestCode(ctx, c, l, actorFor(req)));
  });

  app.post('/api/r/:token/verify', limitVerify, async (req, reply) => {
    const { token } = params.parse(req.params);
    const { code } = z.object({ code: z.string().regex(/^\d{6,8}$/) }).parse(req.body);
    const l = await lookupOr404(token);
    if (!l) throw notFound();
    const s = await ctx.db.tx((c) => R.verifyCode(ctx, c, l, code, actorFor(req)));
    if (!s.ok) {
      if (s.reason === 'not_available') throw new HttpError(409, 'Verification is not available for this link', 'not_available');
      throw new HttpError(s.status, 'That code is not valid. Request a new code if it has expired.', 'bad_code');
    }
    reply.setCookie(R.RECIPIENT_COOKIE, s.token, { ...cookieOptions(ctx), path: `/api/r/${token}` });
    return { ok: true, view: await R.authorisedView(ctx, ctx.db, l, s.session) };
  });

  /** Bearer mode: explicit button press creates the session; a bare GET never does. */
  app.post('/api/r/:token/open', limitVerify, async (req, reply) => {
    const { token } = params.parse(req.params);
    const l = await lookupOr404(token);
    if (!l) throw notFound();
    const s = await ctx.db.tx((c) => R.bearerSession(ctx, c, l, actorFor(req)));
    reply.setCookie(R.RECIPIENT_COOKIE, s.token, { ...cookieOptions(ctx), path: `/api/r/${token}` });
    return { ok: true, view: await R.authorisedView(ctx, ctx.db, l, s.session) };
  });

  async function requireSession(req: FastifyRequest, token: string) {
    const l = await lookupOr404(token);
    if (!l) throw notFound();
    const s = await R.loadRecipientSession(ctx, ctx.db, l, cookieFor(req));
    if (!s) {
      const state = R.publicState(ctx, l);
      throw new HttpError(401, state === 'needs_verification' || state === 'bearer_ready' ? 'Verification required' : 'This transfer is no longer available', state === 'needs_verification' ? 'verify_required' : 'gone');
    }
    return { l, s };
  }

  app.get('/api/r/:token/view', limitLight, async (req) => {
    const { token } = params.parse(req.params);
    const { l, s } = await requireSession(req, token);
    const seen = await ctx.db.query(`SELECT 1 FROM audit_events WHERE actor_session_id = $1 AND event_type = 'recipient.page_viewed' LIMIT 1`, [s.id]);
    if (!seen.rowCount) {
      await audit(ctx.db, { actorKind: s.mode === 'required' ? 'recipient' : 'anonymous', actorEmail: s.verified_email, actorSessionId: s.id, transferId: l.transfer.id, grantId: l.grant.id, eventType: 'recipient.page_viewed', ...actorFor(req) });
    }
    return R.authorisedView(ctx, ctx.db, l, s);
  });

  const fileParams = z.object({ token: z.string().min(40).max(50), fileId: z.string().uuid() });
  const fileHandler = async (req: FastifyRequest, reply: Parameters<typeof streamFile>[2]) => {
    const { token, fileId } = fileParams.parse(req.params);
    const { l, s } = await requireSession(req, token);
    const f = await releasedFile(ctx.db, l.transfer.id, fileId);
    if (!f) throw notFound('File not found');
    return streamFile(ctx, req, reply, l, s, f, actorFor(req));
  };
  // Fastify registers HEAD automatically for GET routes (exposeHeadRoutes); our handler honours HEAD.
  app.get('/api/r/:token/files/:fileId', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, fileHandler);

  app.get('/api/r/:token/zip', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { token } = params.parse(req.params);
    const { l, s } = await requireSession(req, token);
    return streamZip(ctx, req, reply, l, s, actorFor(req));
  });

  /** Optional client acknowledgement that the browser reported the download finished. Separate from server completion. */
  app.post('/api/r/:token/files/:fileId/ack', limitLight, async (req) => {
    const { token, fileId } = fileParams.parse(req.params);
    const { l, s } = await requireSession(req, token);
    await ctx.db.query(`UPDATE download_attempts SET client_ack_at = now() WHERE grant_id = $1 AND session_id = $2 AND file_id = $3 AND client_ack_at IS NULL`, [l.grant.id, s.id, fileId]);
    await audit(ctx.db, { actorKind: s.mode === 'required' ? 'recipient' : 'anonymous', actorEmail: s.verified_email, actorSessionId: s.id, transferId: l.transfer.id, grantId: l.grant.id, fileId, eventType: 'download.client_acknowledged', outcome: 'info', ...actorFor(req) });
    return { ok: true };
  });

  app.post('/api/r/:token/signout', limitLight, async (req, reply) => {
    const { token } = params.parse(req.params);
    const l = await lookupOr404(token);
    const cookie = cookieFor(req);
    if (l && cookie) {
      const s = await R.loadRecipientSession(ctx, ctx.db, l, cookie);
      if (s) await ctx.db.query(`UPDATE recipient_sessions SET revoked_at = now() WHERE id = $1`, [s.id]);
    }
    reply.clearCookie(R.RECIPIENT_COOKIE, { path: `/api/r/${token}` });
    return { ok: true };
  });
}
