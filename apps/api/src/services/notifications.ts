import type { Queryable } from '../db.js';
import type { AppContext } from '../context.js';
import { enqueue } from '../lib/jobs.js';
import type { TemplateKey } from '../lib/templates.js';

export interface OutboxInput {
  kind: TemplateKey;
  to: string;
  toUserId?: string | null;
  transferId?: string | null;
  grantId?: string | null;
  data: Record<string, unknown>;
  dedupeKey?: string;
}

/**
 * Queue an email through the transactional outbox. Must be called with the same client as the
 * state change so both commit or neither does. Duplicate dedupe keys are silently ignored.
 */
export async function queueEmail(q: Queryable, input: OutboxInput): Promise<number | null> {
  const r = await q.query<{ id: number }>(
    `INSERT INTO outbox_messages(kind, to_email, to_user_id, transfer_id, grant_id, data, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [input.kind, input.to, input.toUserId ?? null, input.transferId ?? null, input.grantId ?? null, JSON.stringify(input.data), input.dedupeKey ?? null],
  );
  const id = r.rows[0]?.id ?? null;
  if (id !== null) await enqueue(q, 'deliver_outbox', { outboxId: id }, { idempotencyKey: `outbox:${id}`, priority: 50 });
  return id;
}

export async function inApp(q: Queryable, input: { userId: string; kind: string; title: string; body?: string; transferId?: string | null; dedupeKey?: string }) {
  await q.query(
    `INSERT INTO in_app_notifications(user_id, kind, title, body, transfer_id, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [input.userId, input.kind, input.title, input.body ?? '', input.transferId ?? null, input.dedupeKey ?? null],
  );
}

/** Operational alert for administrators: in-app for all admins, plus email if configured. */
export async function raiseAlert(ctx: AppContext, q: Queryable, input: { kind: string; severity: 'warning' | 'critical'; message: string; details?: Record<string, unknown>; dedupeKey?: string }) {
  const ins = await q.query<{ id: number }>(
    `INSERT INTO operational_alerts(kind, severity, message, details, dedupe_key) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
    [input.kind, input.severity, input.message, JSON.stringify(input.details ?? {}), input.dedupeKey ?? null],
  );
  if (!ins.rows[0]) return; // already open
  const admins = await q.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE role = 'admin' AND status = 'active'`);
  for (const a of admins.rows) {
    await inApp(q, { userId: a.id, kind: 'alert', title: input.message, dedupeKey: `alert:${ins.rows[0].id}:${a.id}` });
  }
  const np = await ctx.settings.get('notifications');
  const emails = np.adminAlertEmails.length ? np.adminAlertEmails : admins.rows.map((a) => a.email);
  for (const to of emails) {
    await queueEmail(q, {
      kind: 'admin_alert',
      to,
      data: { severity: input.severity, message: input.message, link: new URL('/admin/health', ctx.config.publicUrl).toString() },
      dedupeKey: `alert:${ins.rows[0].id}:${to.toLowerCase()}`,
    });
  }
}

export async function resolveAlert(q: Queryable, dedupeKey: string) {
  await q.query(`UPDATE operational_alerts SET resolved_at = now() WHERE dedupe_key = $1 AND resolved_at IS NULL`, [dedupeKey]);
}

/** Mandatory security notice to the affected account. */
export async function securityNotice(ctx: AppContext, q: Queryable, user: { id: string; email: string }, what: string) {
  await queueEmail(q, {
    kind: 'security_notice',
    to: user.email,
    toUserId: user.id,
    data: { what, when: ctx.clock.now().toISOString(), link: new URL('/account/security', ctx.config.publicUrl).toString() },
  });
  await inApp(q, { userId: user.id, kind: 'security', title: what });
}
