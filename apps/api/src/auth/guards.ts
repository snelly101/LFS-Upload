import type { FastifyReply, FastifyRequest } from 'fastify';
import { forbidden, unauthorised, type AppContext } from '../context.js';
import type { SessionRow, UserRow } from './sessions.js';

export interface AuthState {
  user: UserRow;
  session: SessionRow;
  token: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthState | null;
    correlationId: string;
  }
}

export type Role = 'sender' | 'auditor' | 'admin';

export interface GuardOptions {
  roles?: Role[];
  /** 'full' requires MFA complete (default). 'password_only' allows a pre-MFA session (enrolment endpoints). */
  level?: 'full' | 'password_only';
  /** Require recent strong authentication (security-sensitive admin actions). */
  recent?: boolean;
}

export function requireAuth(ctx: AppContext, opts: GuardOptions = {}) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const a = req.auth;
    if (!a) throw unauthorised();
    const level = opts.level ?? 'full';
    if (level === 'full' && a.session.auth_level !== 'full') throw unauthorised('Multi-factor authentication required', 'mfa_required');
    if (a.user.status === 'disabled') throw unauthorised('Account disabled', 'disabled');
    if (opts.roles && !opts.roles.includes(a.user.role)) throw forbidden();
    if (opts.recent) {
      const identity = await ctx.settings.get('identity');
      const last = a.session.last_strong_auth_at ? new Date(a.session.last_strong_auth_at).getTime() : 0;
      if (ctx.clock.now().getTime() - last > identity.recentAuthMinutes * 60_000) {
        throw unauthorised('Recent authentication required', 'recent_auth_required');
      }
    }
  };
}

export function actor(req: FastifyRequest) {
  const a = req.auth;
  return {
    actorKind: 'user' as const,
    actorUserId: a?.user.id ?? null,
    actorEmail: a?.user.email ?? null,
    actorSessionId: a?.session.id ?? null,
    correlationId: req.correlationId,
    ipPrefix: req.ipPrefix,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    ipPrefix: string | null;
  }
}
