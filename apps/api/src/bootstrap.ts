import pino from 'pino';
import { loadConfig, type Config } from './config.js';
import { Db } from './db.js';
import { migrate } from './migrate.js';
import { systemClock, type Clock } from './lib/clock.js';
import { Storage } from './lib/storage.js';
import { ClamdScanner, FakeScanner, type Scanner } from './lib/scanner.js';
import { ActiveStreams } from './lib/activeStreams.js';
import { SettingsService } from './lib/settings.js';
import { createMailer, type Mailer } from './lib/mailer.js';
import type { AppContext } from './context.js';

export interface BootstrapOverrides {
  config?: Partial<Config>;
  clock?: Clock;
  scanner?: Scanner;
  mailer?: Mailer;
  env?: NodeJS.ProcessEnv;
  runMigrations?: boolean;
  /** Tests: capture log output. */
  logDestination?: pino.DestinationStream;
}

export async function createContext(o: BootstrapOverrides = {}): Promise<AppContext> {
  const config = { ...loadConfig(o.env ?? process.env), ...(o.config ?? {}) };
  const logOptions = {
    level: config.LOG_LEVEL,
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', '*.token', '*.code', '*.password', '*.secret'], censor: '[redacted]' },
    serializers: { req: (r: { method?: string; url?: string; id?: string }) => ({ method: r.method, url: String(r.url ?? '').replace(/\/r\/[A-Za-z0-9_-]{20,}/, '/r/[token]').split('?')[0], id: r.id }) },
    ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  };
  const log = o.logDestination ? pino(logOptions, o.logDestination) : pino(logOptions);
  const db = new Db(config.DATABASE_URL);
  if (o.runMigrations !== false) {
    const applied = await migrate(db);
    if (applied.length) log.info({ applied }, 'migrations applied');
  }
  const storage = new Storage(config.CONTENT_ROOT);
  await storage.init();
  const settings = new SettingsService(db, config.serverKey);
  let scanner = o.scanner;
  if (!scanner) {
    if (config.isProd || !process.env.FAKE_SCANNER) scanner = new ClamdScanner(config.CLAMD_HOST, config.CLAMD_PORT, config.CLAMD_TIMEOUT_MS, config.CLAMD_MAX_STREAM_BYTES);
    else scanner = new FakeScanner();
  }
  const mailer = o.mailer ?? createMailer(config, settings);
  if (config.isProd && config.MAIL_TRANSPORT !== 'smtp') throw new Error('Production requires MAIL_TRANSPORT=smtp');
  return { config, db, clock: o.clock ?? systemClock, storage, scanner, streams: new ActiveStreams(), settings, mailer, log };
}
