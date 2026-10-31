import type { Queryable } from '../db.js';
import type { Db } from '../db.js';
import type { Clock } from './clock.js';

export type JobKind =
  | 'scan_file'
  | 'delete_transfer'
  | 'expire_sweep'
  | 'reconcile'
  | 'deliver_outbox'
  | 'sweep_abandoned_uploads'
  | 'purge_audit'
  | 'notify_expiring'
  | 'alert_admins'
  | 'disk_check';

export interface EnqueueOptions {
  idempotencyKey?: string;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
}

/**
 * Enqueue a job. Pass the transaction client so the job commits atomically with the state change
 * (transactional outbox pattern). Duplicate idempotency keys are ignored.
 */
export async function enqueue(q: Queryable, kind: JobKind, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}): Promise<number | null> {
  const r = await q.query<{ id: number }>(
    `INSERT INTO jobs(kind, payload, idempotency_key, run_at, priority, max_attempts)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [kind, JSON.stringify(payload), opts.idempotencyKey ?? null, opts.runAt ?? null, opts.priority ?? 100, opts.maxAttempts ?? 8],
  );
  return r.rows[0]?.id ?? null;
}

export interface ClaimedJob {
  id: number;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** Claim up to n runnable jobs using SKIP LOCKED. Overdue deletions run first (priority ordering). */
export async function claim(db: Db, workerId: string, n: number, kinds?: JobKind[]): Promise<ClaimedJob[]> {
  const r = await db.query<ClaimedJob>(
    `WITH next AS (
       SELECT id FROM jobs
        WHERE state = 'queued' AND run_at <= now() AND ($3::text[] IS NULL OR kind = ANY($3))
        ORDER BY priority ASC, run_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED)
     UPDATE jobs j SET state = 'running', locked_at = now(), locked_by = $1, attempts = j.attempts + 1
       FROM next WHERE j.id = next.id
     RETURNING j.id, j.kind, j.payload, j.attempts, j.max_attempts`,
    [workerId, n, kinds ?? null],
  );
  return r.rows;
}

export async function complete(db: Queryable, id: number) {
  await db.query(`UPDATE jobs SET state = 'done', finished_at = now(), locked_at = NULL, locked_by = NULL WHERE id = $1`, [id]);
}

/** Exponential backoff with jitter: 5s, 10s, 20s ... capped at 10 minutes. */
export function backoffMs(attempt: number): number {
  const base = Math.min(10 * 60 * 1000, 5000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

export async function fail(db: Queryable, job: ClaimedJob, error: unknown, clock: Clock) {
  const msg = redactError(error);
  if (job.attempts >= job.max_attempts) {
    await db.query(`UPDATE jobs SET state = 'dead', last_error = $2, finished_at = now(), locked_at = NULL, locked_by = NULL WHERE id = $1`, [job.id, msg]);
    return 'dead' as const;
  }
  const runAt = new Date(clock.now().getTime() + backoffMs(job.attempts));
  await db.query(`UPDATE jobs SET state = 'queued', last_error = $2, run_at = $3, locked_at = NULL, locked_by = NULL WHERE id = $1`, [job.id, msg, runAt]);
  return 'retry' as const;
}

/** Jobs stuck in running state (worker crashed) are returned to the queue. */
export async function recoverStale(db: Queryable, olderThanMs: number): Promise<number> {
  const r = await db.query(
    `UPDATE jobs SET state = 'queued', locked_at = NULL, locked_by = NULL, last_error = COALESCE(last_error, '') || ' [recovered after stale lock]'
      WHERE state = 'running' AND locked_at < now() - ($1::text || ' milliseconds')::interval`,
    [String(olderThanMs)],
  );
  return r.rowCount ?? 0;
}

export function redactError(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  // never persist anything that looks like a token/secret
  return s.replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]').slice(0, 500);
}

export async function queueStats(db: Queryable) {
  const r = await db.query<{ kind: string; state: string; n: number; oldest: Date | null }>(
    `SELECT kind, state::text, count(*)::int AS n, min(run_at) AS oldest FROM jobs WHERE state IN ('queued','running','dead') GROUP BY kind, state`,
  );
  return r.rows;
}
