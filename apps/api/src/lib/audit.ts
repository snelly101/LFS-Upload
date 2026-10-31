import { createHash } from 'node:crypto';
import type { Queryable } from '../db.js';

export type ActorKind = 'user' | 'recipient' | 'system' | 'anonymous';

export interface AuditInput {
  eventType: string;
  actorKind: ActorKind;
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorSessionId?: string | null;
  transferId?: string | null;
  fileId?: string | null;
  grantId?: string | null;
  targetUserId?: string | null;
  outcome?: 'success' | 'denied' | 'failure' | 'info';
  details?: Record<string, unknown>;
  correlationId?: string | null;
  ipPrefix?: string | null;
  userAgent?: string | null;
}

/** Deterministic JSON: keys sorted recursively so the hash is stable across jsonb round-trips. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

const SECRET_KEYS = /^(token|code|otp|password|secret|client_secret|smtp_url|authorization|cookie|session|recovery)/i;

/** Remove anything that looks like a secret before persisting. */
export function redactDetails(d: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!d) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = '[redacted]';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactDetails(v as Record<string, unknown>);
    } else if (typeof v === 'string') {
      out[k] = v.length > 2000 ? v.slice(0, 2000) + '…' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Append an audit event. The row hash chains to the previous row so tampering with history can be
 * detected by verifyChain(). Must run inside the same transaction as the state change when there is one.
 */
export async function audit(q: Queryable, input: AuditInput): Promise<number> {
  const details = redactDetails(input.details);
  // Serialise chain appends for the rest of the transaction so concurrent writers cannot fork the chain.
  // Lock-ordering rule: acquire row locks (transfer, grant, file) BEFORE calling audit() in a transaction.
  await q.query('SELECT pg_advisory_xact_lock(727002)');
  const prev = await q.query<{ hash: Buffer }>('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1');
  const prevHash = prev.rows[0]?.hash ?? null;
  const userAgentHash = input.userAgent ? createHash('sha256').update(input.userAgent).digest('hex').slice(0, 16) : null;
  const canonical = canonicalJson({
    t: input.eventType,
    ak: input.actorKind,
    au: input.actorUserId ?? null,
    ae: input.actorEmail?.toLowerCase() ?? null,
    tr: input.transferId ?? null,
    f: input.fileId ?? null,
    g: input.grantId ?? null,
    o: input.outcome ?? 'success',
    d: details,
  });
  const hash = createHash('sha256')
    .update(prevHash ?? Buffer.alloc(0))
    .update(canonical)
    .digest();
  const r = await q.query<{ id: number }>(
    `INSERT INTO audit_events(event_type, correlation_id, actor_kind, actor_user_id, actor_email, actor_session_id, transfer_id, file_id, grant_id,
       target_user_id, outcome, details, ip_prefix, user_agent_hash, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [
      input.eventType,
      input.correlationId ?? null,
      input.actorKind,
      input.actorUserId ?? null,
      input.actorEmail ?? null,
      input.actorSessionId ?? null,
      input.transferId ?? null,
      input.fileId ?? null,
      input.grantId ?? null,
      input.targetUserId ?? null,
      input.outcome ?? 'success',
      JSON.stringify(details),
      input.ipPrefix ?? null,
      userAgentHash,
      prevHash,
      hash,
    ],
  );
  return r.rows[0]!.id;
}

/** Recompute the chain and report the first broken link, if any. */
export async function verifyChain(q: Queryable, fromId = 0): Promise<{ ok: boolean; checked: number; brokenAt?: number }> {
  const r = await q.query<{
    id: number;
    event_type: string;
    actor_kind: string;
    actor_user_id: string | null;
    actor_email: string | null;
    transfer_id: string | null;
    file_id: string | null;
    grant_id: string | null;
    outcome: string;
    details: Record<string, unknown>;
    prev_hash: Buffer | null;
    hash: Buffer;
  }>('SELECT * FROM audit_events WHERE id > $1 ORDER BY id ASC', [fromId]);
  let prev: Buffer | null = null;
  let first = true;
  for (const row of r.rows) {
    if (!first && (row.prev_hash === null || !prev || !row.prev_hash.equals(prev))) return { ok: false, checked: r.rows.length, brokenAt: row.id };
    const canonical = canonicalJson({
      t: row.event_type,
      ak: row.actor_kind,
      au: row.actor_user_id,
      ae: row.actor_email?.toLowerCase() ?? null,
      tr: row.transfer_id,
      f: row.file_id,
      g: row.grant_id,
      o: row.outcome,
      d: row.details,
    });
    const expected = createHash('sha256')
      .update(row.prev_hash ?? Buffer.alloc(0))
      .update(canonical)
      .digest();
    if (!expected.equals(row.hash)) return { ok: false, checked: r.rows.length, brokenAt: row.id };
    prev = row.hash;
    first = false;
  }
  return { ok: true, checked: r.rows.length };
}
