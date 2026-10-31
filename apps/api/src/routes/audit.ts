import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor, requireAuth } from '../auth/guards.js';
import { audit } from '../lib/audit.js';
import { transferActivity } from '../services/transfers.js';
import { forbidden } from '../context.js';

const Query = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sender: z.string().max(254).optional(),
  recipient: z.string().max(254).optional(),
  transferId: z.string().uuid().optional(),
  eventType: z.string().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Prevent spreadsheet formula injection: prefix cells starting with = + - @ \t \r with an apostrophe. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export async function auditRoutes(app: FastifyInstance, ctx: AppContext) {
  const anyStaff = { preHandler: requireAuth(ctx, { roles: ['sender', 'auditor', 'admin'] }) };

  async function search(req: Parameters<typeof actor>[0], q: z.infer<typeof Query>) {
    const user = req.auth!.user;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (user.role === 'sender') {
      // Senders see only events about their own transfers (plus their own auth events).
      add(`(transfer_id IN (SELECT id FROM transfers WHERE sender_id = ?) OR (actor_user_id = ? AND transfer_id IS NULL))`.replace('?', `$${params.length + 1}`).replace('?', `$${params.length + 1}`), user.id);
    }
    if (q.from) add(`occurred_at >= ?`, new Date(q.from));
    if (q.to) add(`occurred_at <= ?`, new Date(q.to));
    if (q.transferId) add(`transfer_id = ?`, q.transferId);
    if (q.eventType) add(`event_type LIKE ?`, q.eventType.replace(/[%_]/g, '') + '%');
    if (q.sender) add(`transfer_id IN (SELECT id FROM transfers WHERE sender_email_at_event::text LIKE ?)`, `%${q.sender.toLowerCase()}%`);
    if (q.recipient) {
      const ap = await ctx.settings.get('audit');
      if (user.role === 'auditor' && !ap.auditorsSeeRecipientEmails) throw forbidden('Recipient search is not available to auditors');
      add(`(actor_email::text LIKE ? OR grant_id IN (SELECT id FROM recipient_grants WHERE email::text LIKE ?))`.replace('?', `$${params.length + 1}`).replace('?', `$${params.length + 1}`), `%${q.recipient.toLowerCase()}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events ${w}`, params)).rows[0]!.n;
    const p2 = [...params, q.pageSize, (q.page - 1) * q.pageSize];
    const rows = (
      await ctx.db.query<{ id: number; occurred_at: Date; event_type: string; correlation_id: string | null; actor_kind: string; actor_email: string | null; actor_user_id: string | null; transfer_id: string | null; file_id: string | null; grant_id: string | null; outcome: string; details: Record<string, unknown>; ip_prefix: string | null }>(
        `SELECT id, occurred_at, event_type, correlation_id, actor_kind, actor_email, actor_user_id, transfer_id, file_id, grant_id, outcome, details, ip_prefix FROM audit_events ${w} ORDER BY id DESC LIMIT $${p2.length - 1} OFFSET $${p2.length}`,
        p2,
      )
    ).rows;
    const ap = await ctx.settings.get('audit');
    const hideRecipients = user.role === 'auditor' && !ap.auditorsSeeRecipientEmails;
    return {
      total,
      events: rows.map((e) => ({
        id: e.id,
        occurredAt: e.occurred_at.toISOString(),
        eventType: e.event_type,
        correlationId: e.correlation_id,
        actorKind: e.actor_kind,
        actorEmail: hideRecipients && (e.actor_kind === 'recipient' || (e.grant_id && !e.actor_user_id)) ? '[recipient]' : e.actor_email,
        actorUserId: e.actor_user_id,
        transferId: e.transfer_id,
        fileId: e.file_id,
        grantId: e.grant_id,
        outcome: e.outcome,
        details: hideRecipients ? Object.fromEntries(Object.entries(e.details).filter(([k]) => k !== 'email')) : e.details,
        ipPrefix: user.role === 'sender' ? null : e.ip_prefix,
      })),
    };
  }

  app.get('/api/audit', anyStaff, async (req) => search(req, Query.parse(req.query)));

  app.get('/api/audit/export.csv', anyStaff, async (req, reply) => {
    const q = Query.parse({ ...(req.query as object), pageSize: 200 });
    const header = ['id', 'occurred_at_utc', 'event_type', 'outcome', 'actor_kind', 'actor_email', 'actor_user_id', 'transfer_id', 'file_id', 'grant_id', 'correlation_id', 'ip_prefix', 'details'];
    const lines: string[] = [header.join(',')];
    let page = 1;
    let fetched = 0;
    let total = 0;
    do {
      const r = await search(req, { ...q, page, pageSize: 200 });
      total = r.total;
      for (const e of r.events) lines.push([e.id, e.occurredAt, e.eventType, e.outcome, e.actorKind, e.actorEmail, e.actorUserId, e.transferId, e.fileId, e.grantId, e.correlationId, e.ipPrefix, e.details].map(csvCell).join(','));
      fetched += r.events.length;
      page++;
      if (fetched >= 50_000) break;
    } while (fetched < total);
    await audit(ctx.db, { ...actor(req), eventType: 'audit.exported', details: { rows: fetched, filters: q } });
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="audit-${ctx.clock.now().toISOString().slice(0, 10)}.csv"`);
    reply.header('Cache-Control', 'private, no-store');
    return '﻿' + lines.join('\r\n') + '\r\n';
  });

  /** Per-transfer receipt available to auditors/admins (senders use /api/transfers/:id/activity). */
  app.get('/api/audit/transfers/:id/receipt', { preHandler: requireAuth(ctx, { roles: ['auditor', 'admin'] }) }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = (await ctx.db.query(`SELECT id, title, status, sender_email_at_event, sent_at, expires_at, deletion_status, deletion_completed_at, metadata_purged_at, file_count, total_bytes FROM transfers WHERE id = $1`, [id])).rows[0];
    if (!t) return { transfer: null, events: [] };
    return { transfer: t, events: await transferActivity(ctx.db, id, 2000) };
  });
}
