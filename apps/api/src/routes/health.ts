import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { AppContext } from '../context.js';

type Level = 'ok' | 'warn' | 'fail';

/**
 * Liveness: process is up. Readiness: database reachable and migrations applied. Neither leaks
 * configuration. /statusz is a monitoring summary (levels only, no detail) behind a bearer token;
 * it does not exist unless MONITOR_TOKEN is configured.
 */
export async function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await ctx.db.query('SELECT 1');
      const m = await ctx.db.query(`SELECT count(*)::int AS n FROM schema_migrations`);
      return { ok: true, migrations: m.rows[0]?.n ?? 0 };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  app.get('/statusz', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const expected = ctx.config.MONITOR_TOKEN;
    if (!expected) return reply.status(404).send({ error: 'not_found', message: 'Not found' });
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.status(401).send({ error: 'unauthorised', message: 'Authentication required' });

    const checks: Record<'database' | 'worker' | 'scanner' | 'storage' | 'deletion' | 'email', Level> = { database: 'ok', worker: 'ok', scanner: 'ok', storage: 'ok', deletion: 'ok', email: 'ok' };
    try {
      await ctx.db.query('SELECT 1');
      const sp = await ctx.settings.get('storage');
      const hb = (await ctx.db.query<{ last: Date | null }>(`SELECT max(last_seen) AS last FROM worker_heartbeats`)).rows[0]!.last;
      const age = hb ? ctx.clock.now().getTime() - new Date(hb).getTime() : Infinity;
      checks.worker = age < 90_000 ? 'ok' : age < 10 * 60_000 ? 'warn' : 'fail';
      checks.scanner = (await ctx.scanner.ping()).ok ? 'ok' : 'fail';
      const d = await ctx.storage.diskUsage();
      const freePct = (d.availableBytes / d.totalBytes) * 100;
      checks.storage = freePct < sp.lowDiskCriticalPercent ? 'fail' : freePct < sp.lowDiskWarnPercent ? 'warn' : 'ok';
      const del = (await ctx.db.query<{ failed: number; overdue: number }>(
        `SELECT (SELECT count(*)::int FROM transfers WHERE deletion_status = 'failed') AS failed,
                (SELECT count(*)::int FROM transfers WHERE deletion_status IN ('pending','in_progress') AND deletion_requested_at < now() - make_interval(mins => $1::int)) AS overdue`,
        [sp.deletionTargetMinutes],
      )).rows[0]!;
      checks.deletion = del.failed > 0 ? 'fail' : del.overdue > 0 ? 'warn' : 'ok';
      const mail = (await ctx.db.query<{ failing: number; failed: number }>(
        `SELECT (SELECT count(*)::int FROM operational_alerts WHERE dedupe_key = 'smtp_failure' AND resolved_at IS NULL) AS failing,
                (SELECT count(*)::int FROM outbox_messages WHERE status = 'failed') AS failed`,
      )).rows[0]!;
      checks.email = mail.failing > 0 ? 'fail' : mail.failed > 0 ? 'warn' : 'ok';
    } catch {
      checks.database = 'fail';
    }
    const ok = !Object.values(checks).includes('fail');
    return reply.status(ok ? 200 : 503).header('Cache-Control', 'no-store').send({ ok, checks });
  });
}
