import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { createContext } from '../bootstrap.js';
import { buildApp } from '../app.js';
import type { AppContext } from '../context.js';
import { migrate } from '../migrate.js';
import { TestClock } from '../lib/clock.js';
import { MemoryMailer, type MailMessage } from '../lib/mailer.js';
import { FakeScanner, type Scanner } from '../lib/scanner.js';
import { encryptSecret } from '../lib/crypto.js';
import { hashPassword } from '../auth/passwords.js';
import { Worker } from '../worker/run.js';
import { Db } from '../db.js';

export const PASSWORD = 'correct-horse-battery-staple-2026';
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let passwordHash: string | null = null;

export interface TestUser {
  id: string;
  email: string;
  role: 'sender' | 'auditor' | 'admin';
  mfa: boolean;
}

export interface ApiResponse<T = any> {
  status: number;
  json: T;
  text: string;
  headers: Headers;
  cookie: string;
}

export class Harness {
  ctx!: AppContext;
  app!: FastifyInstance;
  base!: string;
  clock = new TestClock(Date.now());
  mailer = new MemoryMailer();
  fakeScanner = new FakeScanner();
  worker!: Worker;
  logBuffer: string[] = [];
  private counter = 0;

  /** Start a fresh database, storage root and HTTP server. */
  async start(opts: { scanner?: 'fake' | 'real' } = {}) {
    const root = process.env.CONTENT_ROOT!;
    await fs.rm(root, { recursive: true, force: true });
    const admin = new Db(process.env.DATABASE_URL!, 2);
    await admin.query('DROP SCHEMA public CASCADE');
    await admin.query('CREATE SCHEMA public');
    await migrate(admin);
    await admin.close();
    const dest = new Writable({
      write: (chunk, _enc, cb) => {
        this.logBuffer.push(chunk.toString());
        cb();
      },
    });
    const scanner: Scanner | undefined = opts.scanner === 'real' ? undefined : this.fakeScanner;
    this.ctx = await createContext({
      clock: this.clock,
      mailer: this.mailer,
      scanner,
      runMigrations: false,
      logDestination: dest,
      config: { STREAM_RECHECK_MS: 1000, LOG_LEVEL: 'info' },
    });
    this.app = await buildApp(this.ctx);
    await this.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = this.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    this.base = `http://127.0.0.1:${port}`;
    this.worker = new Worker(this.ctx);
    return this;
  }

  async stop() {
    await this.app?.close();
    await this.ctx?.db.close();
  }

  get db() {
    return this.ctx.db;
  }

  async createUser(role: 'sender' | 'auditor' | 'admin' = 'sender', opts: { mfa?: boolean; email?: string } = {}): Promise<TestUser> {
    passwordHash ??= await hashPassword(PASSWORD);
    const email = opts.email ?? `${role}${++this.counter}@test.invalid`;
    const mfa = opts.mfa ?? true;
    const id = await this.db.tx(async (c) => {
      const u = await c.query<{ id: string }>(`INSERT INTO users(email, display_name, role, auth_kind, status) VALUES ($1,$2,$3,'local','active') RETURNING id`, [email, `User ${email}`, role]);
      const id = u.rows[0]!.id;
      await c.query(`INSERT INTO local_credentials(user_id, password_hash, email_verified_at, password_changed_at) VALUES ($1,$2,now(),now())`, [id, passwordHash]);
      if (mfa) await c.query(`INSERT INTO mfa_totp(user_id, secret_enc, confirmed_at) VALUES ($1,$2,now())`, [id, encryptSecret(this.ctx.config.serverKey, TOTP_SECRET, 'totp')]);
      return id;
    });
    return { id, email, role, mfa };
  }

  totpCode(): string {
    return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(TOTP_SECRET) }).generate({ timestamp: this.clock.now().getTime() });
  }

  /** Log in and complete TOTP. Advances the clock one TOTP step so repeated logins never reuse a code. */
  async login(user: TestUser, opts: { mfa?: boolean } = {}): Promise<string> {
    this.clock.advance(31_000);
    const r = await this.api('POST', '/api/auth/login', { email: user.email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
    if (opts.mfa === false || !user.mfa) return r.cookie;
    const m = await this.api('POST', '/api/auth/mfa/totp/verify', { code: this.totpCode() }, r.cookie);
    if (m.status !== 200) throw new Error(`mfa failed: ${m.status} ${m.text}`);
    return m.cookie;
  }

  /** JSON API call. Returns the merged cookie string for follow-up calls. */
  async api<T = any>(method: string, path: string, body?: unknown, cookie = '', headers: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const h: Record<string, string> = { 'x-requested-with': 'securesend', ...headers };
    if (cookie) h.cookie = cookie;
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      if (body instanceof Uint8Array || typeof body === 'string') payload = body as BodyInit;
      else {
        h['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    } else if (!['GET', 'HEAD'].includes(method)) {
      h['content-type'] = 'application/json';
      payload = '{}';
    }
    const r = await fetch(this.base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json, text, headers: r.headers, cookie: mergeCookies(cookie, r.headers.getSetCookie()) };
  }

  /** Raw fetch with cookie (for downloads / tus). */
  raw(path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.cookie) headers.cookie = init.cookie;
    return fetch(this.base + path, { ...init, headers, redirect: 'manual' });
  }

  /** Register a file on a transfer and upload it via the tus protocol. */
  async tusUpload(cookie: string, transferId: string, name: string, data: Buffer | { size: number; chunk: (offset: number, len: number) => Buffer }, opts: { chunkSize?: number; stopAfterBytes?: number; declaredSize?: number } = {}) {
    const size = Buffer.isBuffer(data) ? data.length : data.size;
    const reg = await this.api('POST', `/api/transfers/${transferId}/files`, { name, sizeBytes: opts.declaredSize ?? size }, cookie);
    if (reg.status !== 201) throw new Error(`register failed ${reg.status} ${reg.text}`);
    const uploadId: string = reg.json.uploadId;
    const location = await this.tusCreate(cookie, uploadId, opts.declaredSize ?? size);
    const offset = await this.tusPatch(cookie, location, data, 0, opts);
    return { fileId: reg.json.file.id as string, uploadId, location, offset };
  }

  async tusCreate(cookie: string, uploadId: string, length: number): Promise<string> {
    const r = await this.raw('/api/uploads/tus', { method: 'POST', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-length': String(length), 'upload-metadata': `uploadId ${Buffer.from(uploadId).toString('base64')}` } });
    if (r.status !== 201) throw new Error(`tus create failed ${r.status} ${await r.text()}`);
    return r.headers.get('location')!;
  }

  async tusHead(cookie: string, location: string) {
    const r = await this.raw(location, { method: 'HEAD', cookie, headers: { 'tus-resumable': '1.0.0' } });
    return { status: r.status, offset: Number(r.headers.get('upload-offset')), length: Number(r.headers.get('upload-length')) };
  }

  async tusPatch(cookie: string, location: string, data: Buffer | { size: number; chunk: (offset: number, len: number) => Buffer }, start: number, opts: { chunkSize?: number; stopAfterBytes?: number } = {}) {
    const size = Buffer.isBuffer(data) ? data.length : data.size;
    const CH = opts.chunkSize ?? 1024 * 1024;
    let offset = start;
    while (offset < size) {
      if (opts.stopAfterBytes !== undefined && offset - start >= opts.stopAfterBytes) break;
      const len = Math.min(CH, size - offset);
      const chunk = Buffer.isBuffer(data) ? data.subarray(offset, offset + len) : data.chunk(offset, len);
      const r = await this.raw(location, { method: 'PATCH', cookie, headers: { 'tus-resumable': '1.0.0', 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' }, body: new Uint8Array(chunk) });
      if (r.status !== 204) throw new Error(`tus patch failed ${r.status} ${await r.text()}`);
      offset = Number(r.headers.get('upload-offset'));
    }
    return offset;
  }

  /** Create a transfer with files, recipients and send it; returns detail + raw invitation tokens per email. */
  async sendTransfer(cookie: string, opts: { title?: string; files?: Record<string, Buffer>; recipients?: string[]; body?: Record<string, unknown> } = {}) {
    const t = await this.api('POST', '/api/transfers', { title: opts.title ?? 'Test transfer', ...(opts.body ?? {}) }, cookie);
    if (t.status !== 201) throw new Error(`create failed ${t.status} ${t.text}`);
    const id: string = t.json.id;
    const files = opts.files ?? { 'hello.txt': Buffer.from('hello world\n') };
    for (const [name, buf] of Object.entries(files)) await this.tusUpload(cookie, id, name, buf);
    await this.worker.drain();
    const rec = opts.recipients ?? ['sam@example.invalid'];
    const pr = await this.api('PUT', `/api/transfers/${id}/recipients`, { emails: rec }, cookie);
    if (pr.status !== 200) throw new Error(`recipients failed ${pr.status} ${pr.text}`);
    const sent = await this.api('POST', `/api/transfers/${id}/send`, {}, cookie);
    if (sent.status !== 200) throw new Error(`send failed ${sent.status} ${sent.text}`);
    await this.worker.drain();
    const tokens: Record<string, string> = {};
    for (const email of rec) {
      const mail = this.findMail((m) => m.to === email && /has sent you/.test(m.subject));
      if (!mail) throw new Error(`no invitation for ${email}`);
      tokens[email] = mail.text.match(/\/r\/([A-Za-z0-9_-]+)/)![1]!;
    }
    return { id, detail: sent.json, tokens };
  }

  /** Request a code for a token, pull it from the mail sink and verify; returns recipient cookie + view. */
  async verifyRecipient(token: string) {
    const before = this.mailer.sent.length;
    const rq = await this.api('POST', `/api/r/${token}/code`, {});
    if (rq.status !== 200) throw new Error(`code request failed ${rq.status} ${rq.text}`);
    await this.worker.drain(['deliver_outbox']);
    const mail = this.mailer.sent.slice(before).find((m) => /verification code/i.test(m.subject));
    if (!mail) throw new Error('no code mail');
    const code = mail.text.match(/code is: (\d+)/)![1]!;
    const v = await this.api('POST', `/api/r/${token}/verify`, { code });
    if (v.status !== 200) throw new Error(`verify failed ${v.status} ${v.text}`);
    return { cookie: v.cookie, view: v.json.view, code };
  }

  findMail(pred: (m: MailMessage) => boolean): MailMessage | undefined {
    return this.mailer.sent.find(pred);
  }

  /** Make every queued job claimable now (tests that move the clock far ahead). */
  async runQueuedJobsNow() {
    await this.db.query(`UPDATE jobs SET run_at = now() WHERE state = 'queued'`);
  }

  async audits(transferId: string, type?: string) {
    const r = await this.db.query<{ event_type: string; outcome: string; details: Record<string, unknown>; actor_kind: string }>(`SELECT event_type, outcome, details, actor_kind FROM audit_events WHERE transfer_id = $1 ${type ? 'AND event_type = $2' : ''} ORDER BY id`, type ? [transferId, type] : [transferId]);
    return r.rows;
  }
}

export function mergeCookies(existing: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const c of existing.split('; ').filter(Boolean)) {
    const i = c.indexOf('=');
    jar.set(c.slice(0, i), c.slice(i + 1));
  }
  for (const sc of setCookies) {
    const kv = sc.split(';')[0]!;
    const i = kv.indexOf('=');
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    if (v === '' || /max-age=0/i.test(sc) || /expires=thu, 01 jan 1970/i.test(sc)) jar.delete(k);
    else jar.set(k, v);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Deterministic position-keyed byte generator usable for multi-GiB streams without buffering (offsets must be 4-aligned). */
export function prngSource(size: number, seed = 1) {
  const mix = (w: number) => {
    let x = (w ^ (seed * 0x9e3779b1)) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
  };
  return {
    size,
    chunk(offset: number, len: number): Buffer {
      const out = Buffer.alloc(len);
      for (let i = 0; i + 4 <= len; i += 4) out.writeUInt32LE(mix((offset + i) / 4), i);
      for (let i = len - (len % 4); i < len; i++) out[i] = mix((offset + i) / 4) & 0xff;
      return out;
    },
  };
}
