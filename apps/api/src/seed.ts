import type { AppContext } from './context.js';
import { hashPassword } from './auth/passwords.js';
import { audit } from './lib/audit.js';
import * as OTPAuth from 'otpauth';
import { encryptSecret } from './lib/crypto.js';

/**
 * Development seed: clearly fictitious accounts and transfers. Never runs in production.
 * Accounts (password "correct-horse-battery-staple-2026", TOTP secret printed):
 *   admin@dev.securesend.invalid (admin), alex.sender@dev.securesend.invalid (sender), audrey.audit@dev.securesend.invalid (auditor)
 */
export async function seedDevelopment(ctx: AppContext) {
  const password = await hashPassword('correct-horse-battery-staple-2026');
  const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const users = [
    ['admin@dev.securesend.invalid', 'Dev Administrator', 'admin'],
    ['alex.sender@dev.securesend.invalid', 'Alex Sender', 'sender'],
    ['audrey.audit@dev.securesend.invalid', 'Audrey Auditor', 'auditor'],
  ] as const;
  for (const [email, name, role] of users) {
    await ctx.db.tx(async (c) => {
      const u = await c.query<{ id: string }>(`INSERT INTO users(email, display_name, role, auth_kind, status) VALUES ($1,$2,$3,'local','active') ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role RETURNING id`, [email, name, role]);
      const id = u.rows[0]!.id;
      await c.query(`INSERT INTO local_credentials(user_id, password_hash, email_verified_at, password_changed_at) VALUES ($1,$2,now(),now()) ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, email_verified_at = now()`, [id, password]);
      await c.query(`INSERT INTO mfa_totp(user_id, secret_enc, confirmed_at) VALUES ($1,$2,now()) ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, confirmed_at = now()`, [id, encryptSecret(ctx.config.serverKey, totpSecret, 'totp')]);
      await audit(c, { actorKind: 'system', eventType: 'dev.seeded', targetUserId: id, details: { email, role } });
    });
  }
  console.log(`Seed TOTP secret (all dev accounts): ${totpSecret}`);
  console.log(`Current code: ${new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totpSecret) }).generate()}`);
}
