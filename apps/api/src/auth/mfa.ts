import * as OTPAuth from 'otpauth';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { decryptSecret, encryptSecret, randomRecoveryCode } from '../lib/crypto.js';
import { hashPassword, verifyPassword } from './passwords.js';

export interface MfaStatus {
  totp: boolean;
  passkeys: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[];
  recoveryCodesRemaining: number;
  enrolled: boolean;
}

export async function mfaStatus(q: Queryable, userId: string): Promise<MfaStatus> {
  const totp = await q.query(`SELECT 1 FROM mfa_totp WHERE user_id = $1 AND confirmed_at IS NOT NULL`, [userId]);
  const pk = await q.query<{ id: string; label: string; created_at: Date; last_used_at: Date | null }>(
    `SELECT id, label, created_at, last_used_at FROM mfa_webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  const rc = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  const hasTotp = (totp.rowCount ?? 0) > 0;
  return {
    totp: hasTotp,
    passkeys: pk.rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null })),
    recoveryCodesRemaining: rc.rows[0]!.n,
    enrolled: hasTotp || pk.rows.length > 0,
  };
}

// ------------------------------------------------------------------ TOTP
export async function beginTotpEnrolment(ctx: AppContext, q: Queryable, user: { id: string; email: string }, productName: string) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({ issuer: productName, label: user.email, algorithm: 'SHA1', digits: 6, period: 30, secret });
  await q.query(
    `INSERT INTO mfa_totp(user_id, secret_enc, confirmed_at) VALUES ($1, $2, NULL)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed_at = NULL, last_used_step = NULL
     WHERE mfa_totp.confirmed_at IS NULL`,
    [user.id, encryptSecret(ctx.config.serverKey, secret.base32, 'totp')],
  );
  const row = await q.query<{ confirmed_at: Date | null }>(`SELECT confirmed_at FROM mfa_totp WHERE user_id = $1`, [user.id]);
  if (row.rows[0]?.confirmed_at) throw new Error('TOTP already enrolled');
  return { otpauthUrl: totp.toString(), secretBase32: secret.base32 };
}

export async function verifyTotp(ctx: AppContext, q: Queryable, userId: string, token: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
  const row = await q.query<{ secret_enc: Buffer; confirmed_at: Date | null; last_used_step: number | null }>(`SELECT secret_enc, confirmed_at, last_used_step FROM mfa_totp WHERE user_id = $1 FOR UPDATE`, [userId]);
  const r = row.rows[0];
  if (!r) return false;
  if (!opts.confirm && !r.confirmed_at) return false;
  if (!/^\d{6}$/.test(token)) return false;
  const base32 = decryptSecret(ctx.config.serverKey, r.secret_enc, 'totp').toString('utf8');
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(base32) });
  const ts = ctx.clock.now().getTime();
  const delta = totp.validate({ token, timestamp: ts, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(ts / 30_000) + delta;
  if (r.last_used_step !== null && step <= r.last_used_step) return false; // replay / reuse protection
  await q.query(`UPDATE mfa_totp SET last_used_step = $2, confirmed_at = COALESCE(confirmed_at, now()) WHERE user_id = $1`, [userId, step]);
  return true;
}

// ------------------------------------------------------------------ Recovery codes
export async function regenerateRecoveryCodes(q: Queryable, userId: string): Promise<string[]> {
  await q.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const code = randomRecoveryCode();
    codes.push(code);
    await q.query(`INSERT INTO mfa_recovery_codes(user_id, code_hash) VALUES ($1, $2)`, [userId, await hashPassword(code)]);
  }
  return codes;
}

/** Consume a recovery code atomically (row lock). */
export async function consumeRecoveryCode(q: Queryable, userId: string, code: string): Promise<boolean> {
  const norm = code.trim().toLowerCase();
  if (!/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(norm)) return false;
  const rows = await q.query<{ id: string; code_hash: string }>(`SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL FOR UPDATE`, [userId]);
  for (const r of rows.rows) {
    if (await verifyPassword(r.code_hash, norm)) {
      const upd = await q.query(`UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [r.id]);
      return (upd.rowCount ?? 0) === 1;
    }
  }
  return false;
}

// ------------------------------------------------------------------ WebAuthn
function rp(ctx: AppContext) {
  return { rpID: ctx.config.publicUrl.hostname, origin: ctx.config.publicUrl.origin };
}

export async function beginPasskeyRegistration(ctx: AppContext, q: Queryable, user: { id: string; email: string; display_name: string }, productName: string) {
  const existing = await q.query<{ credential_id: string; transports: string[] }>(`SELECT credential_id, transports FROM mfa_webauthn_credentials WHERE user_id = $1`, [user.id]);
  const options = await generateRegistrationOptions({
    rpName: productName,
    rpID: rp(ctx).rpID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    userDisplayName: user.display_name || user.email,
    attestationType: 'none',
    excludeCredentials: existing.rows.map((r) => ({ id: r.credential_id, transports: r.transports as never })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  await q.query(`DELETE FROM auth_challenges WHERE user_id = $1 AND purpose = 'webauthn_register'`, [user.id]);
  await q.query(`INSERT INTO auth_challenges(user_id, purpose, challenge, expires_at) VALUES ($1, 'webauthn_register', $2, now() + interval '5 minutes')`, [user.id, options.challenge]);
  return options;
}

export async function finishPasskeyRegistration(ctx: AppContext, q: Queryable, userId: string, response: RegistrationResponseJSON, label: string) {
  const ch = await q.query<{ id: string; challenge: string }>(
    `SELECT id, challenge FROM auth_challenges WHERE user_id = $1 AND purpose = 'webauthn_register' AND consumed_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
    [userId],
  );
  const c = ch.rows[0];
  if (!c) throw new Error('No registration in progress');
  await q.query(`UPDATE auth_challenges SET consumed_at = now() WHERE id = $1`, [c.id]);
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: c.challenge,
    expectedOrigin: rp(ctx).origin,
    expectedRPID: rp(ctx).rpID,
    requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) throw new Error('Passkey registration could not be verified');
  const info = v.registrationInfo;
  await q.query(
    `INSERT INTO mfa_webauthn_credentials(user_id, credential_id, public_key, counter, transports, aaguid, backed_up, label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, info.credential.id, Buffer.from(info.credential.publicKey), info.credential.counter, info.credential.transports ?? [], info.aaguid, info.credentialBackedUp, label.slice(0, 60) || 'Passkey'],
  );
}

export async function beginPasskeyAuthentication(ctx: AppContext, q: Queryable, userId: string) {
  const creds = await q.query<{ credential_id: string; transports: string[] }>(`SELECT credential_id, transports FROM mfa_webauthn_credentials WHERE user_id = $1`, [userId]);
  if (creds.rows.length === 0) throw new Error('No passkeys enrolled');
  const options = await generateAuthenticationOptions({
    rpID: rp(ctx).rpID,
    userVerification: 'required',
    allowCredentials: creds.rows.map((r) => ({ id: r.credential_id, transports: r.transports as never })),
  });
  await q.query(`DELETE FROM auth_challenges WHERE user_id = $1 AND purpose = 'webauthn_auth'`, [userId]);
  await q.query(`INSERT INTO auth_challenges(user_id, purpose, challenge, expires_at) VALUES ($1, 'webauthn_auth', $2, now() + interval '5 minutes')`, [userId, options.challenge]);
  return options;
}

export async function finishPasskeyAuthentication(ctx: AppContext, q: Queryable, userId: string, response: AuthenticationResponseJSON): Promise<boolean> {
  const ch = await q.query<{ id: string; challenge: string }>(
    `SELECT id, challenge FROM auth_challenges WHERE user_id = $1 AND purpose = 'webauthn_auth' AND consumed_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1 FOR UPDATE`,
    [userId],
  );
  const c = ch.rows[0];
  if (!c) return false;
  await q.query(`UPDATE auth_challenges SET consumed_at = now() WHERE id = $1`, [c.id]);
  const cred = await q.query<{ id: string; credential_id: string; public_key: Buffer; counter: number; transports: string[] }>(
    `SELECT id, credential_id, public_key, counter, transports FROM mfa_webauthn_credentials WHERE user_id = $1 AND credential_id = $2 FOR UPDATE`,
    [userId, response.id],
  );
  const cr = cred.rows[0];
  if (!cr) return false;
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: rp(ctx).origin,
      expectedRPID: rp(ctx).rpID,
      requireUserVerification: true,
      credential: { id: cr.credential_id, publicKey: new Uint8Array(cr.public_key), counter: Number(cr.counter), transports: cr.transports as never },
    });
    if (!v.verified) return false;
    await q.query(`UPDATE mfa_webauthn_credentials SET counter = $2, last_used_at = now() WHERE id = $1`, [cr.id, v.authenticationInfo.newCounter]);
    return true;
  } catch {
    return false;
  }
}
