import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

/** Liveness: process is up. Readiness: database reachable and migrations applied. Neither leaks configuration. */
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
}
