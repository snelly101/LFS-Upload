import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 32 random bytes as base64url – used for invitation tokens, session ids, account tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

/** Keyed hash for low-entropy secrets (OTP codes). */
export function hmacSha256(key: Buffer, input: string | Buffer): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Numeric one-time code with uniform distribution (crypto randomInt). */
export function randomNumericCode(digits = 6): string {
  const max = 10 ** digits;
  return randomInt(0, max).toString().padStart(digits, '0');
}

/** Recovery code like "k7fd-3n2p-9xqa" (base32 alphabet without ambiguous chars). */
export function randomRecoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const parts: string[] = [];
  for (let p = 0; p < 3; p++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[randomInt(0, alphabet.length)];
    parts.push(s);
  }
  return parts.join('-');
}

/** AES-256-GCM with a random 12-byte nonce; output = nonce || tag || ciphertext. */
export function encryptSecret(key: Buffer, plaintext: string | Buffer, aad = 'snelson'): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.subarray(0, 32), nonce);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

export function decryptSecret(key: Buffer, blob: Buffer, aad = 'snelson'): Buffer {
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key.subarray(0, 32), nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Reduce an IP to a privacy-preserving prefix (/24 for IPv4, /48 for IPv6). */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  if (ip.includes('.')) {
    const parts = ip.replace(/^::ffff:/, '').split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    return null;
  }
  const groups = ip.split(':');
  return `${groups.slice(0, 3).join(':')}::/48`;
}
