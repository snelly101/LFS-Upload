import type pino from 'pino';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Clock } from './lib/clock.js';
import type { Storage } from './lib/storage.js';
import type { Scanner } from './lib/scanner.js';
import type { ActiveStreams } from './lib/activeStreams.js';
import type { SettingsService } from './lib/settings.js';
import type { Mailer } from './lib/mailer.js';

export interface AppContext {
  config: Config;
  db: Db;
  clock: Clock;
  storage: Storage;
  scanner: Scanner;
  streams: ActiveStreams;
  settings: SettingsService;
  mailer: Mailer;
  log: pino.Logger;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export const notFound = (msg = 'Not found') => new HttpError(404, msg, 'not_found');
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg, 'forbidden');
export const badRequest = (msg: string, code = 'bad_request', extra?: Record<string, unknown>) => new HttpError(400, msg, code, extra);
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, msg, code);
export const unauthorised = (msg = 'Authentication required', code = 'unauthorised') => new HttpError(401, msg, code);
