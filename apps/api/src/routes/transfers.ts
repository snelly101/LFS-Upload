import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor, requireAuth } from '../auth/guards.js';
import * as T from '../services/transfers.js';

export async function transferRoutes(app: FastifyInstance, ctx: AppContext) {
  const sender = { preHandler: requireAuth(ctx, { roles: ['sender', 'admin'] }) };
  const act = (req: Parameters<typeof actor>[0]): T.ActorInfo => ({ ...actor(req), actorUserId: req.auth!.user.id, actorEmail: req.auth!.user.email });

  /** Effective limits for the composer (locked values are reported so the UI can explain them). */
  app.get('/api/transfers/policy', sender, async (req) => {
    const s = await ctx.settings.all();
    const usage = await T.quotaUsage(ctx.db, req.auth!.user.id);
    const quota = req.auth!.user.quota_bytes ?? s.transferPolicy.defaultUserQuotaBytes;
    const disk = await ctx.storage.diskUsage();
    return {
      transferPolicy: s.transferPolicy,
      verification: { mode: s.verification.mode, codeTtlSeconds: s.verification.codeTtlSeconds, locked: s.verification.mode !== 'sender_choice' },
      notifications: { senderChoices: s.notifications.senderChoices, defaults: s.notifications.defaults },
      quota: { quotaBytes: quota, usedBytes: usage.usedBytes, reservedBytes: usage.reservedBytes },
      disk: { availableBytes: disk.availableBytes, totalBytes: disk.totalBytes },
      scannerMaxBytes: ctx.config.CLAMD_MAX_STREAM_BYTES,
    };
  });

  app.get('/api/transfers', sender, async (req) => {
    const query = T.ListQuerySchema.parse(req.query);
    return T.listTransfers(ctx.db, { senderId: req.auth!.user.id }, query);
  });

  app.post('/api/transfers', sender, async (req, reply) => {
    const input = T.CreateTransferSchema.parse(req.body ?? {});
    const t = await ctx.db.tx((c) => T.createTransfer(ctx, c, req.auth!.user, input, act(req)));
    reply.status(201);
    return T.transferDetail(ctx, ctx.db, t);
  });

  app.get('/api/transfers/:id', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await T.loadOwnedTransfer(ctx.db, id, req.auth!.user.id);
    return T.transferDetail(ctx, ctx.db, t);
  });

  app.patch('/api/transfers/:id', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const input = T.CreateTransferSchema.partial().parse(req.body ?? {});
    const t = await ctx.db.tx((c) => T.updateTransfer(ctx, c, req.auth!.user, id, input, act(req)));
    return T.transferDetail(ctx, ctx.db, t);
  });

  app.get('/api/transfers/:id/activity', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await T.loadOwnedTransfer(ctx.db, id, req.auth!.user.id);
    return { events: await T.transferActivity(ctx.db, id) };
  });

  app.post('/api/transfers/:id/files', sender, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const input = T.AddFileSchema.parse(req.body);
    const f = await ctx.db.tx((c) => T.addFile(ctx, c, req.auth!.user, id, input, act(req)));
    reply.status(201);
    return { file: T.fileView(f), uploadId: f.upload_id, tusEndpoint: '/api/uploads/tus' };
  });

  app.delete('/api/transfers/:id/files/:fileId', sender, async (req) => {
    const { id, fileId } = z.object({ id: z.string().uuid(), fileId: z.string().uuid() }).parse(req.params);
    await ctx.db.tx((c) => T.removeFile(ctx, c, req.auth!.user.id, id, fileId, act(req)));
    return { ok: true };
  });

  app.put('/api/transfers/:id/recipients', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { emails } = z.object({ emails: T.RecipientsSchema }).parse(req.body);
    await ctx.db.tx((c) => T.setRecipients(ctx, c, req.auth!.user.id, id, emails, act(req)));
    return T.transferDetail(ctx, ctx.db, await T.loadOwnedTransfer(ctx.db, id, req.auth!.user.id));
  });

  app.post('/api/transfers/:id/recipients', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { email, reason } = z.object({ email: z.string().email().max(254), reason: z.string().min(1).max(500) }).parse(req.body);
    await ctx.db.tx((c) => T.addRecipientAfterSend(ctx, c, req.auth!.user, id, email, reason, act(req)));
    return T.transferDetail(ctx, ctx.db, await T.loadOwnedTransfer(ctx.db, id, req.auth!.user.id));
  });

  app.post('/api/transfers/:id/send', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await ctx.db.tx((c) => T.sendTransfer(ctx, c, req.auth!.user, id, act(req)));
    return T.transferDetail(ctx, ctx.db, t);
  });

  app.post('/api/transfers/:id/revoke', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason, deleteNow } = z.object({ reason: z.string().max(500).default(''), deleteNow: z.boolean().default(false) }).parse(req.body ?? {});
    const t = await ctx.db.tx((c) => T.revokeTransfer(ctx, c, req.auth!.user.id, id, { reason, deleteNow }, act(req)));
    return T.transferDetail(ctx, ctx.db, t);
  });

  app.post('/api/transfers/:id/delete-now', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await ctx.db.tx(async (c) => {
      const t = await T.loadOwnedTransfer(c, id, req.auth!.user.id, true);
      if (t.status === 'active') await T.revokeTransfer(ctx, c, req.auth!.user.id, id, { reason: 'delete_now', deleteNow: true }, act(req));
      else await T.requestDeletion(ctx, c, t.id, 'sender_requested', act(req));
    });
    return T.transferDetail(ctx, ctx.db, await T.loadOwnedTransfer(ctx.db, id, req.auth!.user.id));
  });

  app.post('/api/transfers/:id/extend', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { expiresAt, reason } = z.object({ expiresAt: z.string().datetime(), reason: z.string().min(1).max(500) }).parse(req.body);
    const t = await ctx.db.tx((c) => T.extendExpiry(ctx, c, req.auth!.user.id, id, new Date(expiresAt), reason, act(req)));
    return T.transferDetail(ctx, ctx.db, t);
  });

  app.post('/api/transfers/:id/grants/:grantId/revoke', sender, async (req) => {
    const { id, grantId } = z.object({ id: z.string().uuid(), grantId: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().max(500).default('') }).parse(req.body ?? {});
    await ctx.db.tx((c) => T.revokeGrant(ctx, c, req.auth!.user.id, id, grantId, reason, act(req)));
    return T.transferDetail(ctx, ctx.db, await T.loadOwnedTransfer(ctx.db, id, req.auth!.user.id));
  });

  app.post('/api/transfers/:id/grants/:grantId/resend', sender, async (req) => {
    const { id, grantId } = z.object({ id: z.string().uuid(), grantId: z.string().uuid() }).parse(req.params);
    await ctx.db.tx((c) => T.resendInvitation(ctx, c, req.auth!.user, id, grantId, act(req)));
    return { ok: true };
  });
}
