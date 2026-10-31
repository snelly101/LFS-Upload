import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor, requireAuth } from '../auth/guards.js';
import { audit } from '../lib/audit.js';

export async function notificationRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = { preHandler: requireAuth(ctx) };

  app.get('/api/notifications', auth, async (req) => {
    const r = await ctx.db.query<{ id: number; kind: string; title: string; body: string; transfer_id: string | null; created_at: Date; read_at: Date | null }>(
      `SELECT id, kind, title, body, transfer_id, created_at, read_at FROM in_app_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.auth!.user.id],
    );
    const unread = (await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM in_app_notifications WHERE user_id = $1 AND read_at IS NULL`, [req.auth!.user.id])).rows[0]!.n;
    return { unread, items: r.rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, transferId: n.transfer_id, createdAt: n.created_at.toISOString(), readAt: n.read_at?.toISOString() ?? null })) };
  });

  app.post('/api/notifications/read', auth, async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).max(500).optional() }).parse(req.body ?? {});
    if (ids) await ctx.db.query(`UPDATE in_app_notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL`, [req.auth!.user.id, ids]);
    else await ctx.db.query(`UPDATE in_app_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.auth!.user.id]);
    return { ok: true };
  });

  /** Per-user default notification preferences (applied to new transfers; policy decides what is choosable). */
  app.put('/api/notifications/preferences', auth, async (req) => {
    const prefs = z.record(z.boolean()).parse(req.body);
    const np = await ctx.settings.get('notifications');
    const allowed = Object.fromEntries(Object.entries(prefs).filter(([k]) => k in np.defaults && (np.senderChoices as Record<string, boolean>)[k]));
    await ctx.db.query(`UPDATE users SET notification_prefs = $2 WHERE id = $1`, [req.auth!.user.id, JSON.stringify(allowed)]);
    await audit(ctx.db, { ...actor(req), eventType: 'user.preferences_changed', details: { keys: Object.keys(allowed) } });
    return { preferences: allowed };
  });

  app.put('/api/account/profile', auth, async (req) => {
    const body = z.object({ displayName: z.string().max(120).optional(), timeZone: z.string().max(64).optional() }).parse(req.body);
    if (body.timeZone) {
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: body.timeZone });
      } catch {
        return { error: 'Invalid time zone' };
      }
    }
    await ctx.db.query(`UPDATE users SET display_name = COALESCE($2, display_name), time_zone = COALESCE($3, time_zone) WHERE id = $1`, [req.auth!.user.id, body.displayName?.trim() ?? null, body.timeZone ?? null]);
    return { ok: true };
  });
}
