import type { AppContext } from '../context.js';
import { claim, complete, enqueue, fail, recoverStale, type ClaimedJob, type JobKind } from '../lib/jobs.js';
import * as H from './handlers.js';

/**
 * Worker loop. Claims runnable jobs with SKIP LOCKED, runs them with bounded concurrency, and
 * schedules the periodic sweeps itself (idempotent keys bucketed by time) so no cron is needed.
 */
export class Worker {
  private stopped = false;
  private inFlight = new Set<Promise<void>>();
  constructor(private readonly ctx: AppContext) {}

  async runJob(job: ClaimedJob) {
    const ctx = this.ctx;
    switch (job.kind as JobKind) {
      case 'scan_file':
        return H.scanFile(ctx, job);
      case 'delete_transfer':
        return H.deleteTransfer(ctx, job);
      case 'expire_sweep':
        return void (await H.expireSweep(ctx));
      case 'reconcile':
        return void (await H.reconcileStorage(ctx));
      case 'sweep_abandoned_uploads':
        return void (await H.sweepAbandonedUploads(ctx));
      case 'deliver_outbox':
        return H.deliverOutbox(ctx, job);
      case 'notify_expiring':
        return H.notifyExpiring(ctx, job);
      case 'purge_audit':
        return void (await H.purgeAudit(ctx));
      case 'disk_check':
        return H.diskCheck(ctx);
      case 'alert_admins':
        return;
      default:
        throw new Error(`unknown job kind ${job.kind}`);
    }
  }

  /** Enqueue periodic jobs; idempotency keys make this safe to call from every worker tick. */
  async schedulePeriodic() {
    const now = this.ctx.clock.now().getTime();
    const bucket = (ms: number) => Math.floor(now / ms);
    await enqueue(this.ctx.db, 'expire_sweep', {}, { idempotencyKey: `expire_sweep:${bucket(60_000)}`, priority: 10, maxAttempts: 3 });
    await enqueue(this.ctx.db, 'disk_check', {}, { idempotencyKey: `disk_check:${bucket(5 * 60_000)}`, maxAttempts: 2 });
    await enqueue(this.ctx.db, 'reconcile', {}, { idempotencyKey: `reconcile:${bucket(60 * 60_000)}`, priority: 15, maxAttempts: 3 });
    await enqueue(this.ctx.db, 'sweep_abandoned_uploads', {}, { idempotencyKey: `sweep_abandoned:${bucket(60 * 60_000)}`, maxAttempts: 3 });
    await enqueue(this.ctx.db, 'purge_audit', {}, { idempotencyKey: `purge_audit:${bucket(24 * 60 * 60_000)}`, maxAttempts: 3 });
    // Housekeeping of our own queue + outbox table
    await this.ctx.db.query(`DELETE FROM jobs WHERE state = 'done' AND finished_at < now() - interval '7 days'`);
  }

  /** Process everything runnable right now (used by tests and the startup pass). */
  async tick(kinds?: JobKind[]): Promise<number> {
    const free = this.ctx.config.WORKER_CONCURRENCY - this.inFlight.size;
    if (free <= 0) return 0;
    const jobs = await claim(this.ctx.db, this.ctx.config.WORKER_ID, free, kinds);
    for (const job of jobs) {
      const p = (async () => {
        try {
          await this.runJob(job);
          await complete(this.ctx.db, job.id);
        } catch (e) {
          const r = await fail(this.ctx.db, job, e, this.ctx.clock);
          this.ctx.log.warn({ job: job.kind, id: job.id, attempts: job.attempts, result: r, err: e instanceof Error ? e.message : String(e) }, 'job failed');
          if (r === 'dead') {
            await this.ctx.db.query(`INSERT INTO operational_alerts(kind, severity, message, details, dedupe_key) VALUES ('job_dead','critical',$1,$2,$3) ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL DO NOTHING`, [
              `Job ${job.kind} #${job.id} exhausted retries`,
              JSON.stringify({ kind: job.kind, payload: job.payload }),
              `job_dead:${job.id}`,
            ]);
          }
        }
      })();
      this.inFlight.add(p);
      void p.finally(() => this.inFlight.delete(p));
    }
    return jobs.length;
  }

  /** Drain: run ticks until nothing runnable remains (tests). */
  async drain(kinds?: JobKind[], maxRounds = 50) {
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.tick(kinds);
      await Promise.all([...this.inFlight]);
      if (n === 0) break;
    }
  }

  async heartbeat() {
    await this.ctx.db.query(`INSERT INTO worker_heartbeats(worker_id, last_seen, details) VALUES ($1, now(), $2) ON CONFLICT (worker_id) DO UPDATE SET last_seen = now(), details = EXCLUDED.details`, [
      this.ctx.config.WORKER_ID,
      JSON.stringify({ inFlight: this.inFlight.size, pid: process.pid }),
    ]);
  }

  async start() {
    this.ctx.log.info({ worker: this.ctx.config.WORKER_ID }, 'worker starting');
    const recovered = await recoverStale(this.ctx.db, 30 * 60_000);
    if (recovered) this.ctx.log.warn({ recovered }, 'recovered stale jobs');
    // Startup pass: overdue deletions first, then everything else.
    await this.schedulePeriodic();
    await this.tick(['delete_transfer', 'expire_sweep']);
    let lastPeriodic = 0;
    let lastHeartbeat = 0;
    while (!this.stopped) {
      try {
        const now = Date.now();
        if (now - lastPeriodic > 30_000) {
          await this.schedulePeriodic();
          lastPeriodic = now;
        }
        if (now - lastHeartbeat > 10_000) {
          await this.heartbeat();
          lastHeartbeat = now;
        }
        await recoverStale(this.ctx.db, 30 * 60_000);
        const n = await this.tick();
        if (n === 0) await new Promise((r) => setTimeout(r, this.ctx.config.WORKER_POLL_MS));
      } catch (e) {
        this.ctx.log.error({ err: e }, 'worker loop error');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await Promise.all([...this.inFlight]);
  }

  stop() {
    this.stopped = true;
  }
}
