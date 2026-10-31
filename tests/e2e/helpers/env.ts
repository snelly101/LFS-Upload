import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// otpauth comes from the api workspace (dev-only dependency path).
const OTPAuth = require('/home/user/LFS-Upload/apps/api/node_modules/otpauth') as typeof import('otpauth');

export const ADMIN = { email: 'admin@dev.snelson.invalid', password: 'correct-horse-battery-staple-2026', totpSecret: process.env.E2E_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };
export const MAIL_DIR = process.env.E2E_MAIL_DIR ?? '/home/user/LFS-Upload/var/mail';

export function totpCode(secret = ADMIN.totpSecret): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

/** Find the newest mail in the file sink matching a predicate (polls for up to `ms`). */
export async function waitForMail(pred: (text: string) => boolean, ms = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fs.existsSync(MAIL_DIR)) {
      const files = fs.readdirSync(MAIL_DIR).sort().reverse();
      for (const f of files) {
        const txt = fs.readFileSync(path.join(MAIL_DIR, f), 'utf8');
        if (pred(txt)) return txt;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('mail not found');
}

export function makeFixture(name: string, bytes: number): string {
  const dir = '/tmp/snelson-e2e';
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 4096) buf.writeUInt32LE((i * 2654435761) >>> 0, Math.min(i, bytes - 4));
  fs.writeFileSync(p, buf);
  return p;
}
