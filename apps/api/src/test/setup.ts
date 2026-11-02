import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load apps/api/.env.test into process.env (no external dotenv dependency).
const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../../.env.test');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
}
if (!process.env.DATABASE_URL?.includes('securesend_test')) throw new Error('refusing to run tests against a non-test database');
