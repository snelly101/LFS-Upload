import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import fs from 'node:fs';
import { z } from 'zod';
import { Server, EVENTS } from '@tus/server';
import { FileStore } from '@tus/file-store';
import type { AppContext } from '../context.js';
import { HttpError, notFound } from '../context.js';
import { actor, requireAuth } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { enqueue } from '../lib/jobs.js';
import { contentDisposition } from '../lib/filenames.js';
import * as T from '../services/transfers.js';
import * as Q from '../services/requests.js';
import * as R from '../services/recipients.js';
import { parseRange } from '../services/downloads.js';

type TusReq = { runtime?: { node?: { req?: IncomingMessage } } };
interface InboundRaw extends IncomingMessage {
  ssInbound?: { token: string; l: NonNullable<R.GrantLookup>; s: R.RecipientSessionRow; cid: string; ipPrefix: string | null };
}
class TusError extends Error {
  constructor(
    public status_code: number,
    public body: string,
  ) {
    super(body);
  }
}

/**
 * File requests. Staff create a request and download what arrives; verified contributors upload
 * through a tus endpoint scoped to their own invitation token and recipient session.
 */
export async function requestRoutes(app: FastifyInstance, ctx: AppContext) {
  const sender = { preHandler: requireAuth(ctx, { roles: ['sender', 'admin'] }) };
  const act = (req: FastifyRequest): T.ActorInfo => ({ ...actor(req), actorUserId: req.auth!.user.id, actorEmail: req.auth!.user.email });

  // ------------------------------------------------------------------ staff
  app.post('/api/requests', sender, async (req, reply) => {
    const input = Q.CreateRequestSchema.parse(req.body);
    const t = await ctx.db.tx((c) => Q.createFileRequest(ctx, c, req.auth!.user, input, act(req)));
    reply.status(201);
    return T.transferDetail(ctx, ctx.db, t);
  });

  app.post('/api/transfers/:id/close', sender, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().max(500).default('') }).parse(req.body ?? {});
    const t = await ctx.db.tx((c) => Q.closeFileRequest(ctx, c, req.auth!.user.id, id, reason, act(req)));
    return T.transferDetail(ctx, ctx.db, t);
  });

  /**
   * Owner-only download of a received file. Only the member of staff who made the request can read
   * the content (administrators cannot), only after a clean scan, and only until expiry.
   */
  app.get('/api/transfers/:id/files/:fileId/download', { ...sender, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id, fileId } = z.object({ id: z.string().uuid(), fileId: z.string().uuid() }).parse(req.params);
    const { t, f } = await Q.ownerDownloadable(ctx, ctx.db, req.auth!.user.id, id, fileId);
    const range = parseRange(req.headers.range, f.size_bytes);
    const start = range?.start ?? 0;
    const end = range?.end ?? f.size_bytes - 1;
    const length = f.size_bytes === 0 ? 0 : end - start + 1;
    if (start === 0 && req.method !== 'HEAD') {
      await audit(ctx.db, { ...act(req), eventType: 'inbound.downloaded_by_owner', transferId: t.id, fileId: f.id, grantId: f.uploaded_by_grant_id, details: { fileName: f.display_name, sizeBytes: f.size_bytes } });
    }
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('X-Download-Options', 'noopen');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition(f.display_name));
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Length', String(length));
    if (range) {
      reply.status(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${f.size_bytes}`);
    }
    if (req.method === 'HEAD' || length === 0) return reply.send('');
    return reply.send(fs.createReadStream(ctx.storage.pathFor('released', f.id), { start, end, highWaterMark: 1024 * 1024 }));
  });

  // ------------------------------------------------------------------ contributor uploads (tus)
  const store = new FileStore({ directory: ctx.storage.dir('incoming') });

  /** The upload must belong to THIS contributor's grant on THIS request, and still be open. */
  async function ownUpload(raw: InboundRaw, uploadId: string) {
    const c = raw.ssInbound;
    if (!c) throw new TusError(401, 'Verification required');
    const f = (
      await ctx.db.query<T.FileRow & { uploaded_by_grant_id: string | null }>(`SELECT * FROM transfer_files WHERE upload_id = $1`, [uploadId])
    ).rows[0];
    // Same generic 404 for "does not exist" and "not yours".
    if (!f || f.transfer_id !== c.l.transfer.id || f.uploaded_by_grant_id !== c.l.grant.id) throw new TusError(404, 'Upload not found');
    if (f.upload_status === 'finalised' || f.upload_status === 'abandoned') throw new TusError(409, 'Upload is closed');
    return f;
  }
  const rawOf = (req: unknown) => (req as TusReq).runtime?.node?.req as InboundRaw;
  const recipientActor = (c: NonNullable<InboundRaw['ssInbound']>) => ({ actorKind: 'recipient' as const, actorEmail: c.s.verified_email, actorSessionId: c.s.id, transferId: c.l.transfer.id, grantId: c.l.grant.id, correlationId: c.cid, ipPrefix: c.ipPrefix });

  const tus = new Server({
    path: '/api/r',
    datastore: store,
    relativeLocation: true,
    respectForwardedHeaders: false,
    maxSize: async () => T.effectiveMaxFileBytes(await ctx.settings.get('transferPolicy'), ctx.config.CLAMD_MAX_STREAM_BYTES),
    generateUrl: (req, { id }) => `/api/r/${rawOf(req).ssInbound!.token}/tus/${id}`,
    getFileIdFromRequest: (_req, lastPath) => (lastPath && /^[A-Za-z0-9_-]{16,64}$/.test(lastPath) ? lastPath : undefined),
    namingFunction: async (req, metadata) => {
      const uploadId = metadata?.uploadId ?? '';
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(uploadId)) throw new TusError(400, 'uploadId metadata required');
      await ownUpload(rawOf(req), uploadId);
      return uploadId;
    },
    onIncomingRequest: async (req, uploadId) => {
      const raw = rawOf(req);
      if (!raw?.ssInbound) throw new TusError(401, 'Verification required');
      if (uploadId) await ownUpload(raw, uploadId);
    },
    onUploadCreate: async (req, upload) => {
      const raw = rawOf(req);
      const f = await ownUpload(raw, upload.id);
      if (upload.size === undefined) throw new TusError(400, 'Upload-Length is required');
      if (upload.size !== f.size_bytes) throw new TusError(400, 'Upload-Length does not match the registered file size');
      await ctx.db.tx(async (c) => {
        await c.query(`SELECT id FROM transfers WHERE id = $1 FOR UPDATE`, [f.transfer_id]);
        await c.query(`UPDATE transfer_files SET upload_status = 'uploading', storage_state = 'incoming', upload_started_at = COALESCE(upload_started_at, now()) WHERE id = $1 AND upload_status = 'pending'`, [f.id]);
        await audit(c, { ...recipientActor(raw.ssInbound!), eventType: 'upload.started', fileId: f.id, details: { sizeBytes: f.size_bytes, inbound: true } });
      });
      return {};
    },
    onUploadFinish: async (req, upload) => {
      const raw = rawOf(req);
      const f = await ownUpload(raw, upload.id);
      const incoming = ctx.storage.pathFor('incoming', upload.id);
      const actual = await ctx.storage.size(incoming);
      if (actual !== f.size_bytes) {
        await ctx.db.query(`UPDATE transfer_files SET upload_status = 'abandoned', scan_status = 'error', scan_detail = 'size mismatch at finalisation' WHERE id = $1`, [f.id]);
        throw new TusError(409, 'Uploaded size does not match declared size');
      }
      await ctx.storage.move(incoming, ctx.storage.pathFor('quarantine', f.id));
      await ctx.storage.removeIfExists(incoming + '.json');
      await ctx.db.tx(async (c) => {
        await c.query(`SELECT id FROM transfers WHERE id = $1 FOR UPDATE`, [f.transfer_id]);
        await c.query(`UPDATE transfer_files SET upload_status = 'finalised', storage_state = 'quarantine', uploaded_bytes = size_bytes, upload_finished_at = now(), scan_status = 'pending' WHERE id = $1`, [f.id]);
        await c.query(`DELETE FROM storage_reservations WHERE file_id = $1`, [f.id]);
        await enqueue(c, 'scan_file', { fileId: f.id }, { idempotencyKey: `scan:${f.id}`, priority: 30, maxAttempts: 5 });
        await audit(c, { ...recipientActor(raw.ssInbound!), eventType: 'upload.completed', fileId: f.id, details: { sizeBytes: f.size_bytes, inbound: true } });
      });
      return {};
    },
    onResponseError: async (_req, err) => (err instanceof TusError ? { status_code: err.status_code, body: err.body } : undefined),
  });
  tus.on(EVENTS.POST_RECEIVE, (_req, upload) => {
    void ctx.db.query(`UPDATE transfer_files SET uploaded_bytes = $2 WHERE upload_id = $1 AND upload_status = 'uploading'`, [upload.id, upload.offset]).catch(() => undefined);
  });
  tus.on(EVENTS.POST_TERMINATE, (_req, _res, id) => {
    void ctx.db
      .tx(async (c) => {
        const f = (await c.query<T.FileRow>(`SELECT * FROM transfer_files WHERE upload_id = $1 FOR UPDATE`, [id])).rows[0];
        if (!f || f.upload_status === 'finalised' || f.upload_status === 'abandoned') return;
        await c.query(`UPDATE transfer_files SET upload_status = 'abandoned' WHERE id = $1`, [f.id]);
        await c.query(`DELETE FROM storage_reservations WHERE file_id = $1`, [f.id]);
        await c.query(`UPDATE transfers SET file_count = file_count - 1, total_bytes = total_bytes - $2 WHERE id = $1`, [f.transfer_id, f.size_bytes]);
        await audit(c, { actorKind: 'recipient', eventType: 'upload.abandoned', transferId: f.transfer_id, fileId: f.id, details: { inbound: true } });
      })
      .catch((e) => ctx.log.error({ err: e }, 'inbound terminate bookkeeping failed'));
  });

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = z.object({ token: z.string().min(40).max(50) }).parse(req.params);
    R.assertToken(token);
    const l = await R.lookupGrant(ctx.db, token);
    if (!l) throw notFound();
    const s = await R.loadRecipientSession(ctx, ctx.db, l, (req.cookies as Record<string, string | undefined>)[R.RECIPIENT_COOKIE]);
    if (!s) throw new HttpError(401, 'Verification required', 'verify_required');
    if (!Q.acceptingUploads(ctx, l)) throw new HttpError(410, 'This request is no longer accepting files', 'gone');
    const raw = req.raw as InboundRaw;
    raw.ssInbound = { token, l, s, cid: req.correlationId, ipPrefix: req.ipPrefix };
    reply.hijack();
    await tus.handle(req.raw, reply.raw);
  };
  const limit = { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } };
  app.all('/api/r/:token/tus', limit, handler);
  app.all('/api/r/:token/tus/*', limit, handler);
}
