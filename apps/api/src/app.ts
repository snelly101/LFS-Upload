import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AppContext } from './context.js';
import { HttpError } from './context.js';
import { loadSession, SESSION_COOKIE } from './auth/sessions.js';
import { ipPrefix } from './lib/crypto.js';
import { authRoutes } from './routes/auth.js';
import { transferRoutes } from './routes/transfers.js';
import { uploadRoutes } from './routes/uploads.js';
import { recipientRoutes } from './routes/recipient.js';
import { adminRoutes } from './routes/admin.js';
import { auditRoutes } from './routes/audit.js';
import { notificationRoutes } from './routes/notifications.js';
import { healthRoutes } from './routes/health.js';
import { startAccessWatcher } from './services/accessWatcher.js';

export interface BuildOptions {
  serveWeb?: string | null; // path to built web assets
}

export async function buildApp(ctx: AppContext, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.log as unknown as FastifyBaseLogger,
    trustProxy: ctx.config.TRUST_PROXY,
    bodyLimit: 1024 * 1024, // JSON bodies only; file bytes go through tus on the raw socket
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Built-in request logging is disabled: it would log the full URL including recipient tokens.
    // Our onResponse hook logs a redacted URL instead.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Never log cookies, authorisation headers or tokens.
  app.addHook('onRequest', async (req) => {
    req.correlationId = req.id as string;
    req.ipPrefix = ipPrefix(req.ip);
    req.auth = null;
  });
  app.addHook('onResponse', async (req, reply) => {
    const url = (req.raw.url ?? '').replace(/\/r\/[A-Za-z0-9_-]{20,}/, '/r/[token]').split('?')[0];
    req.log.info({ method: req.method, url, status: reply.statusCode, ms: Math.round(reply.elapsedTime), cid: req.correlationId }, 'request');
  });

  await app.register(cookie, { secret: undefined });
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
    hsts: ctx.config.cookieSecure ? { maxAge: 15552000, includeSubDomains: false } : false,
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: [] });

  // Resolve session cookie for every request.
  app.addHook('preHandler', async (req) => {
    const token = (req.cookies as Record<string, string | undefined>)[SESSION_COOKIE];
    if (token) {
      const s = await loadSession(ctx, token);
      if (s) req.auth = { ...s, token };
    }
  });

  // CSRF: cookie-authenticated state-changing API calls must carry our custom header, and Origin (if present) must match.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/r/')) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.url.startsWith('/api/auth/sso/')) return;
    const origin = req.headers.origin;
    if (origin && origin !== ctx.config.publicUrl.origin && !(!ctx.config.isProd && origin.startsWith('http://localhost'))) {
      throw new HttpError(403, 'Cross-origin request rejected', 'csrf');
    }
    const xr = req.headers['x-requested-with'];
    const isTus = req.url.startsWith('/api/uploads/tus');
    if (!xr && !(isTus && req.headers['tus-resumable'])) throw new HttpError(403, 'Missing X-Requested-With header', 'csrf');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code ?? 'error', message: err.message, ...(err.extra ?? {}) });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', message: 'Invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.status(429).send({ error: 'rate_limited', message: 'Too many requests. Please wait and try again.' });
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: 'request_error', message: err instanceof Error ? err.message : 'Request error' });
    req.log.error({ err, cid: req.correlationId }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong. Reference: ' + req.correlationId });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'Not found' });
    return reply.status(404).send({ error: 'not_found', message: 'Not found' });
  });

  await authRoutes(app, ctx);
  await transferRoutes(app, ctx);
  await uploadRoutes(app, ctx);
  await recipientRoutes(app, ctx);
  await adminRoutes(app, ctx);
  await auditRoutes(app, ctx);
  await notificationRoutes(app, ctx);
  await healthRoutes(app, ctx);

  // Serve the built SPA (production). Recipient pages live under /r/... and are served the same bundle.
  if (opts.serveWeb && fs.existsSync(opts.serveWeb)) {
    await app.register(fastifyStatic, { root: opts.serveWeb, prefix: '/', wildcard: false, index: false, setHeaders: (res, p) => {
      res.header('Cache-Control', p.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
    } });
    const indexHtml = fs.readFileSync(path.join(opts.serveWeb, 'index.html'), 'utf8');
    app.get('/*', async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found' });
      reply.header('Cache-Control', 'no-store');
      return reply.type('text/html; charset=utf-8').send(indexHtml);
    });
  }

  const stopWatcher = await startAccessWatcher(ctx);
  app.addHook('onClose', async () => {
    await stopWatcher();
  });
  return app;
}
