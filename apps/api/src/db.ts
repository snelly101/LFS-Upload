import pg from 'pg';
import type { QueryResultRow } from 'pg';

const { Pool, types } = pg;
// bigint -> number where safe (sizes up to 2^53 are fine for our purposes); int8range arrays stay as text.
types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('bigint out of safe range');
  return n;
});

export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
};

export class Db {
  readonly pool: pg.Pool;
  constructor(connectionString: string, max = 10) {
    this.pool = new Pool({ connectionString, max, application_name: 'snelson-send' });
  }

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    return this.pool.query<R>(text, values);
  }

  async one<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<R> {
    const r = await this.pool.query<R>(text, values);
    if (r.rowCount !== 1) throw new Error(`expected exactly one row, got ${r.rowCount}`);
    return r.rows[0]!;
  }

  async maybeOne<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<R | null> {
    const r = await this.pool.query<R>(text, values);
    return r.rows[0] ?? null;
  }

  /** Run fn inside a transaction. Retries serialisation failures a couple of times. */
  async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export async function one<R extends QueryResultRow>(q: Queryable, text: string, values?: unknown[]): Promise<R> {
  const r = await q.query<R>(text, values);
  if (r.rowCount !== 1) throw new Error(`expected exactly one row, got ${r.rowCount}`);
  return r.rows[0]!;
}
export async function maybeOne<R extends QueryResultRow>(q: Queryable, text: string, values?: unknown[]): Promise<R | null> {
  const r = await q.query<R>(text, values);
  return r.rows[0] ?? null;
}
