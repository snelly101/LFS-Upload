import { hash, verify } from '@node-rs/argon2';

const OPTIONS = { memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 };

export async function hashPassword(pw: string): Promise<string> {
  return hash(pw, OPTIONS);
}
export async function verifyPassword(hashed: string, pw: string): Promise<boolean> {
  try {
    return await verify(hashed, pw);
  } catch {
    return false;
  }
}

const COMMON = new Set(['password1234', 'passwordpassword', 'qwertyuiop12', '123456789012', 'letmeinletmein', 'snelsonsend1']);

export function passwordProblems(pw: string, email?: string): string[] {
  const out: string[] = [];
  if (pw.length < 12) out.push('Use at least 12 characters.');
  if (pw.length > 128) out.push('Use at most 128 characters.');
  if (COMMON.has(pw.toLowerCase())) out.push('That password is too common.');
  if (email && pw.toLowerCase().includes(email.split('@')[0]!.toLowerCase()) && email.split('@')[0]!.length >= 4) out.push('Do not include your email address.');
  return out;
}
