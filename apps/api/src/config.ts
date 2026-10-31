import { z } from 'zod';
import path from 'node:path';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** Public origin, e.g. https://send.example.com. Used for links, cookies, OIDC redirect and WebAuthn RP. */
  PUBLIC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  /** 32+ byte base64 key used for HMAC of OTPs/tokens and AES-256-GCM encryption of stored secrets. */
  SERVER_SECRET_KEY: z.string().min(32),
  CONTENT_ROOT: z.string().default(path.resolve(process.cwd(), '../../var/content')),
  CLAMD_HOST: z.string().default('127.0.0.1'),
  CLAMD_PORT: z.coerce.number().int().default(3310),
  CLAMD_TIMEOUT_MS: z.coerce.number().int().default(30 * 60 * 1000),
  /** Must match clamd.conf StreamMaxLength / MaxFileSize. Files above this are reported as not scanned. */
  CLAMD_MAX_STREAM_BYTES: z.coerce.number().int().default(4 * 1024 * 1024 * 1024 - 1),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('Snelson Send <send@localhost>'),
  MAIL_TRANSPORT: z.enum(['smtp', 'file', 'memory']).default('smtp'),
  MAIL_FILE_DIR: z.string().optional(),
  TRUST_PROXY: bool.default(false),
  LOG_LEVEL: z.string().default('info'),
  WORKER_ID: z.string().default(() => `worker-${process.pid}`),
  WORKER_POLL_MS: z.coerce.number().int().default(1000),
  WORKER_CONCURRENCY: z.coerce.number().int().default(4),
  SCAN_CONCURRENCY: z.coerce.number().int().default(1),
  STREAM_RECHECK_MS: z.coerce.number().int().default(2000),
  SESSION_IDLE_MINUTES: z.coerce.number().int().default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().default(12),
  RECENT_AUTH_MINUTES: z.coerce.number().int().default(15),
  RECIPIENT_SESSION_MINUTES: z.coerce.number().int().default(60),
  COOKIE_SECURE: bool.optional(),
  DEV_SEED: bool.default(false),
});

export type Config = z.infer<typeof schema> & {
  publicUrl: URL;
  cookieSecure: boolean;
  serverKey: Buffer;
  isProd: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const c = parsed.data;
  const publicUrl = new URL(c.PUBLIC_URL);
  const isProd = c.NODE_ENV === 'production';
  if (isProd && publicUrl.protocol !== 'https:') throw new Error('PUBLIC_URL must be https in production');
  const serverKey = Buffer.from(c.SERVER_SECRET_KEY, 'base64');
  if (serverKey.length < 32) throw new Error('SERVER_SECRET_KEY must decode to at least 32 bytes (base64)');
  return {
    ...c,
    publicUrl,
    cookieSecure: c.COOKIE_SECURE ?? publicUrl.protocol === 'https:',
    serverKey,
    isProd,
  };
}
