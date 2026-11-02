import pg from 'pg';
import type { AppContext } from '../context.js';

/**
 * Terminates active download streams whose authorisation has lapsed. Two independent triggers:
 *  1. Postgres NOTIFY from triggers on transfers / grants / recipient sessions (immediate).
 *  2. A periodic recheck every STREAM_RECHECK_MS (covers expiry by time and lost notifications).
 * Documented bound: streams stop within 5 seconds of revocation/expiry (recheck interval 2 s + one chunk).
 */
export async function startAccessWatcher(ctx: AppContext): Promise<() => Promise<void>> {
  let stopped = false;
  const recheck = async () => {
    if (stopped || ctx.streams.size === 0) return;
    const streams = ctx.streams.list();
    const sessionIds = [...new Set(streams.map((s) => s.recipientSessionId))];
    const now = ctx.clock.now();
    const r = await ctx.db.query<{ id: string }>(
      `SELECT rs.id FROM recipient_sessions rs
         JOIN recipient_grants g ON g.id = rs.grant_id
         JOIN transfers t ON t.id = rs.transfer_id
        WHERE rs.id = ANY($1::uuid[])
          AND rs.revoked_at IS NULL AND rs.expires_at > $2
          AND g.status = 'invited' AND g.revoked_at IS NULL
          AND t.status = 'active' AND t.expires_at > $2 AND t.deletion_status = 'none'`,
      [sessionIds, now],
    );
    const ok = new Set(r.rows.map((x) => x.id));
    const killed = ctx.streams.killMatching((s) => !ok.has(s.recipientSessionId), 'access_revoked');
    if (killed) ctx.log.info({ killed }, 'terminated streams after access change');
  };

  const timer = setInterval(() => void recheck().catch((e) => ctx.log.error({ err: e }, 'access recheck failed')), ctx.config.STREAM_RECHECK_MS);

  let client: pg.Client | null = null;
  const connect = async () => {
    if (stopped) return;
    client = new pg.Client({ connectionString: ctx.config.DATABASE_URL, application_name: 'securesend-access-watcher' });
    client.on('notification', () => void recheck().catch(() => undefined));
    client.on('error', () => {
      client?.end().catch(() => undefined);
      client = null;
      if (!stopped) setTimeout(() => void connect(), 2000);
    });
    try {
      await client.connect();
      await client.query('LISTEN securesend_access_changed');
    } catch (e) {
      ctx.log.warn({ err: e }, 'access watcher LISTEN failed; relying on periodic recheck');
      client = null;
      if (!stopped) setTimeout(() => void connect(), 5000);
    }
  };
  await connect();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await client?.end().catch(() => undefined);
  };
}
