import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZipArchive } from 'archiver';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import type { Queryable } from '../db.js';
import { audit, type AuditInput } from '../lib/audit.js';
import { contentDisposition } from '../lib/filenames.js';
import type { GrantLookup, RecipientSessionRow } from './recipients.js';
import { notifySender } from './recipients.js';
import { isAccessible } from './transfers.js';

export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/** Parse a single HTTP Range header. Returns null for no/invalid header; throws 416 when unsatisfiable. */
export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // ignore multi-range / malformed: serve whole file (RFC 9110 allows)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) throw new HttpError(416, 'Range not satisfiable');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) throw new HttpError(416, 'Range not satisfiable');
  return { start, end };
}

/** Merge half-open [start,end) intervals; returns merged list and total covered bytes. */
export function mergeRanges(ranges: [number, number][]): { merged: [number, number][]; covered: number } {
  const sorted = ranges.filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return { merged, covered: merged.reduce((n, [s, e]) => n + (e - s), 0) };
}

function parsePgRanges(raw: unknown): [number, number][] {
  // pg returns int8range[] as text like {"[0,100)","[200,300)"}
  if (!raw) return [];
  const s = String(raw);
  const out: [number, number][] = [];
  for (const m of s.matchAll(/\[(\d+),(\d+)\)/g)) out.push([Number(m[1]), Number(m[2])]);
  return out;
}
function toPgRanges(r: [number, number][]): string {
  return `{${r.map(([s, e]) => `"[${s},${e})"`).join(',')}}`;
}

export interface AttemptRow {
  id: string;
  covered: unknown;
  bytes_served: number;
  request_count: number;
  completed_at: Date | null;
}

const MAX_REQUESTS_PER_ATTEMPT = 200;
const ATTEMPT_WINDOW_MS = 24 * 3_600_000;

/**
 * Reserve a download allowance. Semantics (documented in docs/DOWNLOAD-SEMANTICS.md):
 *  - one allowance per (recipient, file) *attempt*; an attempt is scoped to the recipient session
 *  - range/resume requests within an open attempt (same session, same file, not completed, < 24h,
 *    < 200 requests) re-use the attempt and consume nothing
 *  - concurrent starts race on the grant row lock; downloads_used can never exceed the limit
 */
export async function reserveAttempt(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, s: RecipientSessionRow, fileId: string | null, kind: 'file' | 'zip'): Promise<{ attempt: AttemptRow; resumed: boolean }> {
  const g = (await q.query<{ id: string; downloads_used: number }>(`SELECT id, downloads_used FROM recipient_grants WHERE id = $1 FOR UPDATE`, [l.grant.id])).rows[0]!;
  const now = ctx.clock.now();
  const existing = (
    await q.query<AttemptRow>(
      `SELECT id, covered::text AS covered, bytes_served, request_count, completed_at FROM download_attempts
        WHERE grant_id = $1 AND session_id = $2 AND file_id IS NOT DISTINCT FROM $3 AND kind = $4 AND completed_at IS NULL AND started_at > $5
        ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [g.id, s.id, fileId, kind, new Date(now.getTime() - ATTEMPT_WINDOW_MS)],
    )
  ).rows[0];
  if (existing && existing.request_count < MAX_REQUESTS_PER_ATTEMPT) {
    await q.query(`UPDATE download_attempts SET request_count = request_count + 1, last_activity_at = now() WHERE id = $1`, [existing.id]);
    return { attempt: existing, resumed: true };
  }
  const limit = l.transfer.download_limit_per_recipient;
  if (limit !== null) {
    const upd = await q.query(`UPDATE recipient_grants SET downloads_used = downloads_used + 1 WHERE id = $1 AND downloads_used < $2`, [g.id, limit]);
    if (!upd.rowCount) throw new HttpError(429, 'The download limit for this recipient has been reached', 'download_limit');
  }
  const r = await q.query<AttemptRow>(
    `INSERT INTO download_attempts(grant_id, session_id, file_id, kind, request_count, allowance_consumed) VALUES ($1,$2,$3,$4,1,$5) RETURNING id, covered::text AS covered, bytes_served, request_count, completed_at`,
    [g.id, s.id, fileId, kind, limit !== null],
  );
  return { attempt: r.rows[0]!, resumed: false };
}

/** Record served bytes for an attempt and detect completion (full coverage without double counting). */
export async function recordServed(ctx: AppContext, q: Queryable, attemptId: string, range: [number, number], fileSize: number, bytesServed: number): Promise<{ completed: boolean }> {
  const row = (await q.query<AttemptRow>(`SELECT id, covered::text AS covered, bytes_served, request_count, completed_at FROM download_attempts WHERE id = $1 FOR UPDATE`, [attemptId])).rows[0];
  if (!row) return { completed: false };
  const { merged, covered } = mergeRanges([...parsePgRanges(row.covered), range]);
  const complete = covered >= fileSize && merged.length === 1 && merged[0]![0] === 0 && merged[0]![1] >= fileSize;
  await q.query(`UPDATE download_attempts SET covered = $2::int8range[], bytes_served = bytes_served + $3, last_activity_at = now(), completed_at = CASE WHEN $4 AND completed_at IS NULL THEN now() ELSE completed_at END WHERE id = $1`, [
    attemptId,
    toPgRanges(merged),
    bytesServed,
    complete,
  ]);
  return { completed: complete && !row.completed_at };
}

async function onFileCompleted(ctx: AppContext, q: Queryable, l: NonNullable<GrantLookup>, s: RecipientSessionRow, fileId: string, fileName: string, a: Partial<AuditInput>) {
  const { grant, transfer } = l;
  await q.query(`INSERT INTO recipient_file_completion(grant_id, file_id, completed_at) VALUES ($1,$2,now()) ON CONFLICT DO NOTHING`, [grant.id, fileId]);
  await audit(q, { actorKind: s.mode === 'required' ? 'recipient' : 'anonymous', actorEmail: s.verified_email, actorSessionId: s.id, transferId: transfer.id, grantId: grant.id, fileId, eventType: 'download.completed', details: { definition: 'all bytes streamed by server', fileName }, ...a });
  const who = s.verified_email ?? 'A link holder (unverified)';
  const firstEver = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM recipient_file_completion c JOIN recipient_grants g ON g.id = c.grant_id WHERE g.transfer_id = $1`, [transfer.id])).rows[0]!.n === 1;
  if (firstEver) await notifySender(ctx, q, transfer, grant, 'firstDownload', `${who} completed the first download from "${transfer.title || 'Untitled transfer'}"`, `firstdl:${transfer.id}`);
  await notifySender(ctx, q, transfer, grant, 'everyDownload', `${who} downloaded "${fileName}" from "${transfer.title || 'Untitled transfer'}"`, `dl:${grant.id}:${fileId}`);
  const required = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM transfer_files WHERE transfer_id = $1 AND upload_status = 'finalised' AND storage_state = 'released'`, [transfer.id])).rows[0]!.n;
  const done = (await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM recipient_file_completion c JOIN transfer_files f ON f.id = c.file_id WHERE c.grant_id = $1 AND f.storage_state = 'released'`, [grant.id])).rows[0]!.n;
  if (required > 0 && done >= required) {
    const upd = await q.query(`UPDATE recipient_grants SET all_files_completed_at = now() WHERE id = $1 AND all_files_completed_at IS NULL`, [grant.id]);
    if (upd.rowCount) {
      await audit(q, { actorKind: 'system', transferId: transfer.id, grantId: grant.id, eventType: 'download.all_files_completed' });
      await notifySender(ctx, q, transfer, grant, 'firstDownload', `${who} has downloaded all files from "${transfer.title || 'Untitled transfer'}"`, `alldl:${grant.id}`);
    }
  }
}

interface ReleasedFile {
  id: string;
  display_name: string;
  size_bytes: number;
  content_type: string;
}

export async function releasedFile(q: Queryable, transferId: string, fileId: string): Promise<ReleasedFile | null> {
  const r = await q.query<ReleasedFile>(`SELECT id, display_name, size_bytes, content_type FROM transfer_files WHERE id = $1 AND transfer_id = $2 AND upload_status = 'finalised' AND storage_state = 'released' AND scan_status IN ('clean','oversized')`, [fileId, transferId]);
  return r.rows[0] ?? null;
}

function securityHeaders(reply: FastifyReply) {
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
  reply.header('X-Download-Options', 'noopen');
}

/**
 * Stream one file with Range support in bounded memory. Access is re-validated inside the
 * reservation transaction; the stream is registered so revocation/expiry can terminate it.
 */
export async function streamFile(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, l: NonNullable<GrantLookup>, s: RecipientSessionRow, f: ReleasedFile, a: Partial<AuditInput>) {
  const now = ctx.clock.now();
  if (!isAccessible(l.transfer, now)) throw new HttpError(410, 'This transfer is no longer available', 'gone');
  const range = parseRange(req.headers.range, f.size_bytes);
  const { attempt, resumed } = await ctx.db.tx((c) => reserveAttempt(ctx, c, l, s, f.id, 'file'));
  const start = range?.start ?? 0;
  const end = range?.end ?? f.size_bytes - 1;
  const length = f.size_bytes === 0 ? 0 : end - start + 1;
  const path = ctx.storage.pathFor('released', f.id);
  await audit(ctx.db, { actorKind: s.mode === 'required' ? 'recipient' : 'anonymous', actorEmail: s.verified_email, actorSessionId: s.id, transferId: l.transfer.id, grantId: l.grant.id, fileId: f.id, eventType: resumed ? 'download.resumed' : 'download.started', details: { start, end, fileName: f.display_name }, ...a });

  securityHeaders(reply);
  reply.header('Content-Type', 'application/octet-stream');
  reply.header('Content-Disposition', contentDisposition(f.display_name));
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Length', String(length));
  if (range) {
    reply.status(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${f.size_bytes}`);
  }
  if (req.method === 'HEAD') return reply.send();
  if (length === 0) {
    await ctx.db.tx(async (c) => {
      const r = await recordServed(ctx, c, attempt.id, [0, 0], 0, 0);
      if (r.completed) await onFileCompleted(ctx, c, l, s, f.id, f.display_name, a);
    });
    return reply.send('');
  }

  const stream = fs.createReadStream(path, { start, end, highWaterMark: 1024 * 1024 });
  const streamId = randomUUID();
  let served = 0;
  let killed: string | null = null;
  stream.on('data', (chunk: Buffer | string) => {
    served += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
  });
  ctx.streams.add({
    id: streamId,
    transferId: l.transfer.id,
    grantId: l.grant.id,
    recipientSessionId: s.id,
    startedAt: now,
    kill: (reason) => {
      killed = reason;
      stream.destroy();
      reply.raw.destroy();
    },
  });
  const finalise = async () => {
    ctx.streams.remove(streamId);
    const complete = killed === null && served === length && reply.raw.writableFinished;
    try {
      await ctx.db.tx(async (c) => {
        if (served > 0) {
          const r = await recordServed(ctx, c, attempt.id, [start, start + served], f.size_bytes, served);
          if (r.completed) await onFileCompleted(ctx, c, l, s, f.id, f.display_name, a);
        }
        if (!complete) {
          await c.query(`UPDATE download_attempts SET interrupted_at = now() WHERE id = $1`, [attempt.id]);
          await audit(c, { actorKind: s.mode === 'required' ? 'recipient' : 'anonymous', actorEmail: s.verified_email, actorSessionId: s.id, transferId: l.transfer.id, grantId: l.grant.id, fileId: f.id, eventType: 'download.interrupted', outcome: 'info', details: { bytesServed: served, of: length, reason: killed ?? 'client_disconnected' }, ...a });
        }
      });
    } catch (e) {
      ctx.log.error({ err: e }, 'download bookkeeping failed');
    }
  };
  reply.raw.once('close', () => void finalise());
  return reply.send(stream);
}

/**
 * Stream all released files as a ZIP (store method, ZIP64 automatic via archiver). The archive is
 * produced on the fly – no temporary copy – so it cannot be resumed; individual files can be.
 */
export async function streamZip(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, l: NonNullable<GrantLookup>, s: RecipientSessionRow, a: Partial<AuditInput>) {
  const now = ctx.clock.now();
  if (!isAccessible(l.transfer, now)) throw new HttpError(410, 'This transfer is no longer available', 'gone');
  const files = (await ctx.db.query<ReleasedFile>(`SELECT id, display_name, size_bytes, content_type FROM transfer_files WHERE transfer_id = $1 AND upload_status = 'finalised' AND storage_state = 'released' AND scan_status IN ('clean','oversized') ORDER BY created_at`, [l.transfer.id])).rows;
  if (!files.length) throw new HttpError(404, 'No files available');
  // One allowance per file, reserved atomically; all-or-nothing.
  const attempts = await ctx.db.tx(async (c) => {
    const out: { file: ReleasedFile; attemptId: string }[] = [];
    for (const f of files) {
      const { attempt } = await reserveAttempt(ctx, c, l, s, f.id, 'zip');
      out.push({ file: f, attemptId: attempt.id });
    }
    await audit(c, { actorKind: s.mode === 'required' ? 'recipient' : 'anonymous', actorEmail: s.verified_email, actorSessionId: s.id, transferId: l.transfer.id, grantId: l.grant.id, eventType: 'download.zip_started', details: { files: files.length }, ...a });
    return out;
  });
  securityHeaders(reply);
  reply.header('Content-Type', 'application/zip');
  reply.header('Content-Disposition', contentDisposition(`${(l.transfer.title || 'transfer').replace(/[^\w.-]+/g, '_').slice(0, 60)}.zip`));
  reply.header('Accept-Ranges', 'none');
  if (req.method === 'HEAD') return reply.send();

  const archive = new ZipArchive({ store: true, zlib: { level: 0 } });
  const streamId = randomUUID();
  let killed: string | null = null;
  let entriesDone = 0;
  ctx.streams.add({
    id: streamId,
    transferId: l.transfer.id,
    grantId: l.grant.id,
    recipientSessionId: s.id,
    startedAt: now,
    kill: (reason) => {
      killed = reason;
      archive.abort();
      reply.raw.destroy();
    },
  });
  archive.on('entry', () => {
    entriesDone++;
  });
  archive.on('error', (e: Error) => ctx.log.warn({ err: e }, 'zip stream error'));
  for (const { file } of attempts) {
    archive.append(fs.createReadStream(ctx.storage.pathFor('released', file.id), { highWaterMark: 1024 * 1024 }), { name: file.display_name, store: true });
  }
  void archive.finalize();
  const finalise = async () => {
    ctx.streams.remove(streamId);
    const complete = killed === null && entriesDone === attempts.length && reply.raw.writableFinished;
    try {
      await ctx.db.tx(async (c) => {
        for (const { file, attemptId } of attempts) {
          if (complete) {
            const r = await recordServed(ctx, c, attemptId, [0, file.size_bytes], file.size_bytes, file.size_bytes);
            if (r.completed) await onFileCompleted(ctx, c, l, s, file.id, file.display_name, a);
          } else {
            await c.query(`UPDATE download_attempts SET interrupted_at = now(), bytes_served = bytes_served + $2 WHERE id = $1`, [attemptId, 0]);
          }
        }
        if (!complete) await audit(c, { actorKind: s.mode === 'required' ? 'recipient' : 'anonymous', actorEmail: s.verified_email, actorSessionId: s.id, transferId: l.transfer.id, grantId: l.grant.id, eventType: 'download.interrupted', outcome: 'info', details: { kind: 'zip', entriesDone, of: attempts.length, reason: killed ?? 'client_disconnected' }, ...a });
      });
    } catch (e) {
      ctx.log.error({ err: e }, 'zip bookkeeping failed');
    }
  };
  reply.raw.once('close', () => void finalise());
  return reply.send(archive);
}
