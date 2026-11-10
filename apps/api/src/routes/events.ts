import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError } from '../context.js';
import { requireAuth } from '../auth/guards.js';
import { loadSession } from '../auth/sessions.js';
import { EventHub } from '../services/events.js';

/**
 * GET /api/events – Server-Sent Events for signed-in staff. Sends `transfer` {id} when one of the
 * user's transfers changes and `notification` when they have a new in-app notification. The stream
 * is closed when the session is no longer valid; EventSource then reconnects and is refused.
 */
export async function eventRoutes(app: FastifyInstance, ctx: AppContext): Promise<EventHub> {
  const hub = new EventHub(ctx);
  await hub.start();
  app.addHook('onClose', async () => {
    await hub.stop();
  });

  app.get('/api/events', { preHandler: requireAuth(ctx), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = req.auth!;
    if (hub.countFor(a.user.id) >= EventHub.MAX_PER_USER) throw new HttpError(429, 'Too many open tabs', 'too_many_streams');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.write('retry: 5000\n\nevent: ready\ndata: {}\n\n');
    const remove = hub.add(a.user.id, res);
    // Re-validate the session periodically so a revoked or expired session stops receiving events.
    const check = setInterval(() => {
      void loadSession(ctx, a.token)
        .then((s) => {
          if (!s || s.session.auth_level !== 'full') res.end();
        })
        .catch(() => undefined);
    }, 60_000);
    const done = () => {
      clearInterval(check);
      remove();
    };
    req.raw.on('close', done);
    res.on('close', done);
  });
  return hub;
}
