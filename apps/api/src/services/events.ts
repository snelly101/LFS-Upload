import pg from 'pg';
import type { ServerResponse } from 'node:http';
import type { AppContext } from '../context.js';

interface Subscriber {
  userId: string;
  res: ServerResponse;
}

/**
 * Fan-out of database NOTIFY events to connected browsers (Server-Sent Events). One LISTEN
 * connection per API process. Payloads carry ids only; the browser refetches through the normal,
 * authorised API, so this channel can never leak content or another user's data.
 */
export class EventHub {
  private subs = new Set<Subscriber>();
  private client: pg.Client | null = null;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | null = null;
  static readonly MAX_PER_USER = 6;

  constructor(private readonly ctx: AppContext) {}

  async start() {
    this.heartbeat = setInterval(() => {
      for (const s of this.subs) this.write(s, ': ping\n\n');
    }, 25_000);
    await this.connect();
  }

  private async connect() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.ctx.config.DATABASE_URL, application_name: 'securesend-events' });
    client.on('notification', (m) => this.dispatch(m.payload ?? ''));
    client.on('error', () => {
      client.end().catch(() => undefined);
      if (this.client === client) this.client = null;
      if (!this.stopped) setTimeout(() => void this.connect(), 2000);
    });
    try {
      await client.connect();
      await client.query('LISTEN securesend_events');
      this.client = client;
    } catch (e) {
      this.ctx.log.warn({ err: e }, 'event hub LISTEN failed; retrying');
      if (!this.stopped) setTimeout(() => void this.connect(), 5000);
    }
  }

  private dispatch(payload: string) {
    let m: { k?: string; id?: string; u?: string };
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    if (!m.u) return;
    for (const s of this.subs) {
      if (s.userId !== m.u) continue;
      if (m.k === 'transfer' && m.id) this.write(s, `event: transfer\ndata: ${JSON.stringify({ id: m.id })}\n\n`);
      else if (m.k === 'notification') this.write(s, `event: notification\ndata: {}\n\n`);
    }
  }

  private write(s: Subscriber, chunk: string) {
    try {
      if (!s.res.writableEnded) s.res.write(chunk);
    } catch {
      this.subs.delete(s);
    }
  }

  countFor(userId: string): number {
    let n = 0;
    for (const s of this.subs) if (s.userId === userId) n++;
    return n;
  }

  add(userId: string, res: ServerResponse): () => void {
    const s: Subscriber = { userId, res };
    this.subs.add(s);
    return () => this.subs.delete(s);
  }

  /** Close every stream belonging to a user (e.g. their session was revoked). */
  closeUser(userId: string) {
    for (const s of this.subs) {
      if (s.userId === userId) {
        s.res.end();
        this.subs.delete(s);
      }
    }
  }

  get size() {
    return this.subs.size;
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const s of this.subs) s.res.end();
    this.subs.clear();
    await this.client?.end().catch(() => undefined);
  }
}
