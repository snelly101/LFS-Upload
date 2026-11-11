import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Development-only hygiene before the browser suite. Every test run requests verification codes from
 * the same loopback network, and the application (correctly) limits codes per source per hour. Age the
 * dev database's old challenges so repeated local runs do not trip that limit. Never point this at a
 * production database: it refuses any DATABASE_URL that is not on localhost.
 */
export default function globalSetup() {
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/api/.env');
  if (!fs.existsSync(envFile)) return;
  const url = /^DATABASE_URL=(.+)$/m.exec(fs.readFileSync(envFile, 'utf8'))?.[1]?.trim();
  if (!url || !/@(127\.0\.0\.1|localhost)[:/]/.test(url)) return;
  try {
    execFileSync('psql', [url, '-q', '-c', "UPDATE recipient_verifications SET issued_at = issued_at - interval '2 hours' WHERE issued_at > now() - interval '2 hours'"], { stdio: 'ignore' });
  } catch {
    /* psql not available: the suite still runs, but may hit the hourly code limit after many runs */
  }
}
