import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { Server, EVENTS } from '@tus/server';
import { FileStore } from '@tus/file-store';
import fs from 'node:fs/promises';
import type { AppContext } from '../context.js';
import { requireAuth, actor } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { enqueue } from '../lib/jobs.js';
import { recomputeTransferStatus, type FileRow } from '../services/transfers.js';
import type { AuthState } from '../auth/guards.js';
import { inApp } from '../services/notifications.js';

type TusReq = { runtime?: { node?: { req?: IncomingMessage } } };
interface RawWithAuth extends IncomingMessage {
  snelsonAuth?: AuthState;
  snelsonCid?: string;
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
 * Resumable uploads (tus 1.0.0). Every request is authenticated by the session cookie in Fastify
 * before reaching the tus handler. Ownership is enforced per upload id in the tus hooks – the id
 * must belong to a pending/uploading file of a transfer owned by the current user.
 */
export async function uploadRoutes(app: FastifyInstance, ctx: AppContext) {
  const store = new FileStore({ directory: ctx.storage.dir('incoming') });

  async function ownedFile(raw: RawWithAuth, uploadId: string): Promise<FileRow> {
    const auth = raw.snelsonAuth;
    if (!auth) throw new TusError(401, 'Authentication required');
    const r = await ctx.db.query<FileRow & { sender_id: string; tstatus: string }>(
      `SELECT f.*, t.sender_id, t.status::text AS tstatus FROM transfer_files f JOIN transfers t ON t.id = f.transfer_id WHERE f.upload_id = $1`,
      [uploadId],
    );
    const f = r.rows[0];
    // Generic 404 for both "does not exist" and "not yours" so ids cannot be enumerated.
    if (!f || f.sender_id !== auth.user.id) throw new TusError(404, 'Upload not found');
    if (f.upload_status === 'finalised' || f.upload_status === 'abandoned') throw new TusError(409, 'Upload is closed');
    if (!['draft', 'uploading', 'scanning', 'ready'].includes(f.tstatus)) throw new TusError(409, 'Transfer is immutable');
    return f;
  }

  const tus = new Server({
    path: '/api/uploads/tus',
    datastore: store,
    relativeLocation: true,
    respectForwardedHeaders: false,
    maxSize: async () => (await ctx.settings.get('transferPolicy')).maxFileBytes,
    namingFunction: async (req, metadata) => {
      const raw = (req as unknown as TusReq).runtime?.node?.req as RawWithAuth;
      const uploadId = metadata?.uploadId ?? '';
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(uploadId)) throw new TusError(400, 'uploadId metadata required');
      await ownedFile(raw, uploadId);
      return uploadId;
    },
    onIncomingRequest: async (req, uploadId) => {
      const raw = (req as unknown as TusReq).runtime?.node?.req as RawWithAuth;
      if (!raw?.snelsonAuth) throw new TusError(401, 'Authentication required');
      if (uploadId) await ownedFile(raw, uploadId);
    },
    onUploadCreate: async (req, upload) => {
      const raw = (req as unknown as TusReq).runtime?.node?.req as RawWithAuth;
      const f = await ownedFile(raw, upload.id);
      if (upload.size === undefined) throw new TusError(400, 'Upload-Length is required (deferred length is not supported)');
      if (upload.size !== f.size_bytes) throw new TusError(400, 'Upload-Length does not match the registered file size');
      await ctx.db.tx(async (c) => {
        await c.query(`SELECT id FROM transfers WHERE id = $1 FOR UPDATE`, [f.transfer_id]);
        await c.query(`UPDATE transfer_files SET upload_status = 'uploading', storage_state = 'incoming', upload_started_at = COALESCE(upload_started_at, now()) WHERE id = $1 AND upload_status = 'pending'`, [f.id]);
        await audit(c, { ...actor({ auth: raw.snelsonAuth!, correlationId: raw.snelsonCid ?? '', ipPrefix: null, headers: {} } as never), eventType: 'upload.started', transferId: f.transfer_id, fileId: f.id, details: { sizeBytes: f.size_bytes } });
      });
      return {};
    },
    onUploadFinish: async (req, upload) => {
      const raw = (req as unknown as TusReq).runtime?.node?.req as RawWithAuth;
      const f = await ownedFile(raw, upload.id);
      const incoming = ctx.storage.pathFor('incoming', upload.id);
      const actual = await ctx.storage.size(incoming);
      if (actual !== f.size_bytes) {
        await ctx.db.query(`UPDATE transfer_files SET upload_status = 'abandoned', scan_status = 'error', scan_detail = 'size mismatch at finalisation' WHERE id = $1`, [f.id]);
        throw new TusError(409, 'Uploaded size does not match declared size');
      }
      const quarantine = ctx.storage.pathFor('quarantine', f.id);
      await ctx.storage.move(incoming, quarantine);
      await ctx.storage.removeIfExists(incoming + '.json');
      await ctx.db.tx(async (c) => {
        await c.query(`SELECT id FROM transfers WHERE id = $1 FOR UPDATE`, [f.transfer_id]); // lock order: transfer → file → audit
        await c.query(
          `UPDATE transfer_files SET upload_status = 'finalised', storage_state = 'quarantine', uploaded_bytes = size_bytes, upload_finished_at = now(), scan_status = 'pending' WHERE id = $1`,
          [f.id],
        );
        await c.query(`DELETE FROM storage_reservations WHERE file_id = $1`, [f.id]);
        await enqueue(c, 'scan_file', { fileId: f.id }, { idempotencyKey: `scan:${f.id}`, priority: 30, maxAttempts: 5 });
        await audit(c, { ...actor({ auth: raw.snelsonAuth!, correlationId: raw.snelsonCid ?? '', ipPrefix: null, headers: {} } as never), eventType: 'upload.completed', transferId: f.transfer_id, fileId: f.id, details: { sizeBytes: f.size_bytes } });
        await recomputeTransferStatus(c, f.transfer_id);
      });
      return {};
    },
    onResponseError: async (_req, err) => {
      if (err instanceof TusError) return { status_code: err.status_code, body: err.body };
      return undefined;
    },
  });

  tus.on(EVENTS.POST_RECEIVE, (_req, upload) => {
    // progress persisted (throttled by tus postReceiveInterval) so a reconnecting client can show state
    void ctx.db.query(`UPDATE transfer_files SET uploaded_bytes = $2 WHERE upload_id = $1 AND upload_status = 'uploading'`, [upload.id, upload.offset]).catch(() => undefined);
  });
  tus.on(EVENTS.POST_TERMINATE, (_req, _res, id) => {
    void ctx.db.tx(async (c) => {
      const f = (await c.query<FileRow>(`SELECT * FROM transfer_files WHERE upload_id = $1 FOR UPDATE`, [id])).rows[0];
      if (!f || f.upload_status === 'finalised') return;
      await c.query(`UPDATE transfer_files SET upload_status = 'abandoned' WHERE id = $1`, [f.id]);
      await c.query(`DELETE FROM storage_reservations WHERE file_id = $1`, [f.id]);
      await c.query(`UPDATE transfers SET file_count = file_count - 1, total_bytes = total_bytes - $2 WHERE id = $1`, [f.transfer_id, f.size_bytes]);
      await audit(c, { actorKind: 'user', eventType: 'upload.abandoned', transferId: f.transfer_id, fileId: f.id });
      await recomputeTransferStatus(c, f.transfer_id);
    }).catch((e) => ctx.log.error({ err: e }, 'terminate bookkeeping failed'));
  });

  // Body must not be consumed by Fastify.
  app.addContentTypeParser('application/offset+octet-stream', (_req, _payload, done) => done(null));

  const guard = requireAuth(ctx, { roles: ['sender', 'admin'] });
  const handler = async (req: Parameters<typeof guard>[0], reply: Parameters<typeof guard>[1]) => {
    await guard(req, reply);
    const raw = req.raw as RawWithAuth;
    raw.snelsonAuth = req.auth!;
    raw.snelsonCid = req.correlationId;
    reply.hijack();
    await tus.handle(req.raw, reply.raw);
  };
  app.all('/api/uploads/tus', handler);
  app.all('/api/uploads/tus/*', handler);

  // Expired incoming uploads cleanup is handled by the worker's sweep; expose nothing else.
  void fs;
  void inApp;
}
