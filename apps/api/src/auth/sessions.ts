import type { Queryable } from '../db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { AppContext } from '../context.js';

export interface SessionRow {
  id: string;
  user_id: string;
  auth_level: 'password_only' | 'full';
  auth_method: string;
  mfa_method: string | null;
  created_at: Date;
  last_seen_at: Date;
  last_strong_auth_at: Date | null;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: 'sender' | 'auditor' | 'admin';
  auth_kind: 'local' | 'sso';
  status: 'invited' | 'active' | 'disabled';
  notification_prefs: Record<string, boolean>;
  time_zone: string;
  quota_bytes: number | null;
}

export const SESSION_COOKIE = 'ss_session';

export async function createSession(
  ctx: AppContext,
  q: Queryable,
  user: { id: string },
  opts: { authMethod: 'local' | 'sso'; authLevel: 'password_only' | 'full'; mfaMethod?: string | null; ipPrefix?: string | null; userAgent?: string | null },
): Promise<{ token: string; session: SessionRow }> {
  const identity = await ctx.settings.get('identity');
  const token = randomToken(32);
  const now = ctx.clock.now();
  const idle = new Date(now.getTime() + identity.sessionIdleMinutes * 60_000);
  const absolute = new Date(now.getTime() + identity.sessionAbsoluteHours * 3_600_000);
  const r = await q.query<SessionRow>(
    `INSERT INTO sessions(user_id, token_hash, auth_level, auth_method, mfa_method, created_at, last_seen_at, last_strong_auth_at, idle_expires_at, absolute_expires_at, ip_prefix, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      user.id,
      sha256(token),
      opts.authLevel,
      opts.authMethod,
      opts.mfaMethod ?? null,
      now,
      opts.authLevel === 'full' ? now : null,
      idle,
      absolute,
      opts.ipPrefix ?? null,
      (opts.userAgent ?? '').slice(0, 300),
    ],
  );
  return { token, session: r.rows[0]! };
}

/** Rotate the session identifier (after privilege change). Keeps absolute expiry. */
export async function rotateSession(ctx: AppContext, q: Queryable, sessionId: string, patch: { authLevel?: 'full'; mfaMethod?: string }): Promise<string> {
  const token = randomToken(32);
  const now = ctx.clock.now();
  const identity = await ctx.settings.get('identity');
  await q.query(
    `UPDATE sessions SET token_hash = $2, auth_level = COALESCE($3, auth_level), mfa_method = COALESCE($4, mfa_method),
       last_strong_auth_at = CASE WHEN $3 = 'full' THEN $5 ELSE last_strong_auth_at END,
       last_seen_at = $5, idle_expires_at = $6
     WHERE id = $1`,
    [sessionId, sha256(token), patch.authLevel ?? null, patch.mfaMethod ?? null, now, new Date(now.getTime() + identity.sessionIdleMinutes * 60_000)],
  );
  return token;
}

export async function loadSession(ctx: AppContext, token: string): Promise<{ session: SessionRow; user: UserRow } | null> {
  if (!token || token.length > 200) return null;
  const now = ctx.clock.now();
  const r = await ctx.db.query<SessionRow & { u: UserRow }>(
    `SELECT s.*, to_jsonb(u) AS u FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.revoked_at || row.idle_expires_at <= now || row.absolute_expires_at <= now) return null;
  const user = row.u;
  if (user.status !== 'active' && user.status !== 'invited') return null;
  // sliding idle expiry, throttled to one write per minute
  if (now.getTime() - new Date(row.last_seen_at).getTime() > 60_000) {
    const identity = await ctx.settings.get('identity');
    await ctx.db.query(`UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1`, [row.id, now, new Date(now.getTime() + identity.sessionIdleMinutes * 60_000)]);
  }
  const { u: _u, ...session } = row;
  return { session, user };
}

export async function revokeSession(q: Queryable, sessionId: string, reason: string) {
  await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
}

export async function revokeAllSessions(q: Queryable, userId: string, reason: string, exceptSessionId?: string) {
  await q.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`, [userId, reason, exceptSessionId ?? null]);
}

export function cookieOptions(ctx: AppContext, maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    secure: ctx.config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAgeSeconds ? { maxAge: maxAgeSeconds } : {}),
  };
}
