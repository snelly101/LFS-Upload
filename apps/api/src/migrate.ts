import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(db: Db, dir = path.resolve(here, '../migrations')): Promise<string[]> {
  const applied: string[] = [];
  await db.query('SELECT pg_advisory_lock(727001)');
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await fs.readFile(path.join(dir, f), 'utf8');
      await db.tx(async (c) => {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      });
      applied.push(f);
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock(727001)');
  }
  return applied;
}
