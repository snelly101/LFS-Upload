import { SettingsSections, defaultSettings, type AllSettings, type SettingsKey, type EffectivePolicy } from '@securesend/shared';
import type { Db, Queryable } from '../db.js';
import { decryptSecret, encryptSecret } from './crypto.js';

/** Secrets are stored under separate keys, encrypted, and never returned by get(). */
export type SecretKey = 'oidc.clientSecret' | 'smtp.password';

export class SettingsService {
  private cache: AllSettings | null = null;
  private cacheAt = 0;
  constructor(
    private readonly db: Db,
    private readonly serverKey: Buffer,
    private readonly ttlMs = 5000,
  ) {}

  invalidate() {
    this.cache = null;
  }

  async all(force = false): Promise<AllSettings> {
    if (!force && this.cache && Date.now() - this.cacheAt < this.ttlMs) return this.cache;
    const rows = await this.db.query<{ key: string; value: unknown }>(`SELECT key, value FROM settings WHERE key NOT LIKE 'secret:%'`);
    const out = defaultSettings();
    for (const r of rows.rows) {
      const k = r.key as SettingsKey;
      const schema = SettingsSections[k];
      if (!schema) continue;
      const parsed = schema.safeParse(r.value);
      if (parsed.success) (out as Record<string, unknown>)[k] = parsed.data;
    }
    this.cache = out;
    this.cacheAt = Date.now();
    return out;
  }

  async get<K extends SettingsKey>(key: K): Promise<AllSettings[K]> {
    return (await this.all())[key];
  }

  /** Save a section (inside the caller's transaction so it commits with the audit event). */
  async save<K extends SettingsKey>(q: Queryable, key: K, value: AllSettings[K], userId: string | null) {
    const schema = SettingsSections[key];
    const parsed = schema.parse(value);
    await q.query(
      `INSERT INTO settings(key, value, version, updated_at, updated_by) VALUES ($1, $2, 1, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = settings.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(parsed), userId],
    );
    this.invalidate();
    return parsed;
  }

  async setSecret(q: Queryable, key: SecretKey, plaintext: string | null, userId: string | null) {
    if (plaintext === null || plaintext === '') {
      await q.query(`DELETE FROM settings WHERE key = $1`, [`secret:${key}`]);
      return;
    }
    const blob = encryptSecret(this.serverKey, plaintext, `setting:${key}`).toString('base64');
    await q.query(
      `INSERT INTO settings(key, value, version, updated_at, updated_by) VALUES ($1, $2, 1, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = settings.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [`secret:${key}`, JSON.stringify({ v: blob }), userId],
    );
  }

  async getSecret(key: SecretKey): Promise<string | null> {
    const r = await this.db.maybeOne<{ value: { v: string } }>(`SELECT value FROM settings WHERE key = $1`, [`secret:${key}`]);
    if (!r) return null;
    return decryptSecret(this.serverKey, Buffer.from(r.value.v, 'base64'), `setting:${key}`).toString('utf8');
  }

  /** Record an immutable policy snapshot and return its id. */
  async recordPolicyVersion(q: Queryable, userId: string | null, reason: string | null): Promise<number> {
    const all = await this.all(true);
    const r = await q.query<{ id: number }>(`INSERT INTO policy_versions(policy, created_by, reason) VALUES ($1, $2, $3) RETURNING id`, [
      JSON.stringify({ transferPolicy: all.transferPolicy, verification: all.verification, notifications: all.notifications }),
      userId,
      reason,
    ]);
    return r.rows[0]!.id;
  }

  async latestPolicyVersionId(q: Queryable): Promise<number | null> {
    const r = await q.query<{ id: number }>(`SELECT id FROM policy_versions ORDER BY id DESC LIMIT 1`);
    return r.rows[0]?.id ?? null;
  }
}

/**
 * Compute the policy that applies to a transfer. Admin policy is the maximum permission; sender
 * choices may only strengthen. Precedence (tested in policy.test.ts):
 *  1. verification: admin 'required' → required; 'disabled' → bearer; 'sender_choice' → sender's choice (default required)
 *  2. expiry: min(sender choice, admin max)
 *  3. download limit: min(sender choice, admin max) where set
 */
export function computeEffectivePolicy(
  s: AllSettings,
  sender: { verificationMode?: 'required' | 'bearer'; downloadLimit?: number | null },
  policyVersionId: number | null,
): EffectivePolicy {
  const vp = s.verification;
  let verificationMode: 'required' | 'bearer';
  if (vp.mode === 'required') verificationMode = 'required';
  else if (vp.mode === 'disabled') verificationMode = 'bearer';
  else verificationMode = sender.verificationMode ?? 'required';
  const adminMax = s.transferPolicy.maxDownloadsPerRecipient;
  let dl = sender.downloadLimit ?? null;
  if (adminMax !== null) dl = dl === null ? adminMax : Math.min(dl, adminMax);
  return {
    verificationMode,
    verificationPolicyMode: vp.mode,
    maxExpiryHours: s.transferPolicy.maxExpiryHours,
    maxDownloadsPerRecipient: dl,
    allowExpiryExtension: s.transferPolicy.allowExpiryExtension,
    recipientSessionMinutes: vp.recipientSessionMinutes,
    codeTtlSeconds: vp.codeTtlSeconds,
    maxAttempts: vp.maxAttempts,
    resendCooldownSeconds: vp.resendCooldownSeconds,
    policyVersionId,
  };
}
