import fs from 'node:fs';
import path from 'node:path';
import * as OTPAuth from 'otpauth';

export const SENDER = { email: 'alex.sender@dev.securesend.invalid', password: 'correct-horse-battery-staple-2026', totpSecret: process.env.E2E_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };
export const ADMIN = { email: 'admin@dev.securesend.invalid', password: 'correct-horse-battery-staple-2026', totpSecret: process.env.E2E_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };
export const MAIL_DIR = process.env.E2E_MAIL_DIR ?? '/home/user/LFS-Upload/var/mail';

// Shared across Playwright worker processes via a small file in /tmp.
const USED_STEPS_FILE = '/tmp/securesend-e2e-totp-steps.json';
const usedSteps = {
  get(k: string): number | undefined {
    try { return (JSON.parse(fs.readFileSync(USED_STEPS_FILE, 'utf8')) as Record<string, number>)[k]; } catch { return undefined; }
  },
  set(k: string, v: number) {
    let all: Record<string, number> = {};
    try { all = JSON.parse(fs.readFileSync(USED_STEPS_FILE, 'utf8')); } catch { /* first use */ }
    all[k] = v;
    fs.writeFileSync(USED_STEPS_FILE, JSON.stringify(all));
  },
};

/**
 * TOTP codes are single-use per 30 s step (server-side replay protection). Tests share accounts, so
 * if this process already used the current step for an account, wait for the next step first.
 */
export async function freshTotpCode(secret = ADMIN.totpSecret): Promise<string> {
  const step = () => Math.floor(Date.now() / 30_000);
  if (usedSteps.get(secret) === step()) await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 300));
  usedSteps.set(secret, step());
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

export function totpCode(secret = ADMIN.totpSecret): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

export function countMail(pred: (text: string) => boolean): number {
  if (!fs.existsSync(MAIL_DIR)) return 0;
  return fs.readdirSync(MAIL_DIR).filter((f) => pred(fs.readFileSync(path.join(MAIL_DIR, f), 'utf8'))).length;
}

/** Find the newest mail in the file sink matching a predicate (polls for up to `ms`). */
export async function waitForMail(pred: (text: string) => boolean, ms = 30_000, notBefore = 0): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fs.existsSync(MAIL_DIR)) {
      const files = fs.readdirSync(MAIL_DIR).sort().reverse();
      for (const f of files) {
        if (Number(f.split('-')[0]) < notBefore - 1000) continue;
        const txt = fs.readFileSync(path.join(MAIL_DIR, f), 'utf8');
        if (pred(txt)) return txt;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('mail not found');
}

export function makeFixture(name: string, bytes: number): string {
  const dir = '/tmp/securesend-e2e';
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 4096) buf.writeUInt32LE((i * 2654435761) >>> 0, Math.min(i, bytes - 4));
  fs.writeFileSync(p, buf);
  return p;
}
