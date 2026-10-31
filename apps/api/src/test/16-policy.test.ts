import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { defaultSettings } from '@snelson/shared';
import { Harness } from './harness.js';
import { computeEffectivePolicy } from '../lib/settings.js';
import { purgeAudit } from '../worker/handlers.js';
import { expireSweep } from '../worker/handlers.js';

describe('16a. policy precedence (unit)', () => {
  const base = defaultSettings();
  it('admin "required" wins over any sender choice', () => {
    const s = { ...base, verification: { ...base.verification, mode: 'required' as const } };
    expect(computeEffectivePolicy(s, { verificationMode: 'bearer' }, 1).verificationMode).toBe('required');
  });
  it('admin "disabled" means bearer links regardless of sender choice', () => {
    const s = { ...base, verification: { ...base.verification, mode: 'disabled' as const } };
    expect(computeEffectivePolicy(s, { verificationMode: 'required' }, 1).verificationMode).toBe('bearer');
  });
  it('sender_choice defaults to required and honours an explicit bearer choice', () => {
    const s = { ...base, verification: { ...base.verification, mode: 'sender_choice' as const } };
    expect(computeEffectivePolicy(s, {}, 1).verificationMode).toBe('required');
    expect(computeEffectivePolicy(s, { verificationMode: 'bearer' }, 1).verificationMode).toBe('bearer');
  });
  it('download limit is min(sender, admin) and unlimited only when neither sets one', () => {
    const s = { ...base, transferPolicy: { ...base.transferPolicy, maxDownloadsPerRecipient: 5 } };
    expect(computeEffectivePolicy(s, { downloadLimit: 10 }, 1).maxDownloadsPerRecipient).toBe(5);
    expect(computeEffectivePolicy(s, { downloadLimit: 2 }, 1).maxDownloadsPerRecipient).toBe(2);
    expect(computeEffectivePolicy(s, {}, 1).maxDownloadsPerRecipient).toBe(5);
    expect(computeEffectivePolicy(base, {}, 1).maxDownloadsPerRecipient).toBeNull();
    expect(computeEffectivePolicy(base, { downloadLimit: 3 }, 1).maxDownloadsPerRecipient).toBe(3);
  });
  it('records the policy version it was computed from', () => {
    expect(computeEffectivePolicy(base, {}, 42).policyVersionId).toBe(42);
  });
});

const h = new Harness();
let ac = '';
let sc = '';
beforeAll(async () => {
  await h.start();
  ac = await h.login(await h.createUser('admin'));
  sc = await h.login(await h.createUser('sender'));
});
afterAll(() => h.stop());

async function setVerificationMode(mode: 'required' | 'sender_choice' | 'disabled') {
  const settings = await h.api('GET', '/api/admin/settings', undefined, ac);
  const r = await h.api('PUT', '/api/admin/settings/verification', { value: { ...settings.json.settings.verification, mode }, reason: `set ${mode}` }, ac);
  expect(r.status).toBe(200);
}

describe('16b. policy tightening applies to active transfers; loosening does not weaken them; retention purge', () => {
  it('senders cannot weaken a required policy', async () => {
    const r = await h.api('POST', '/api/transfers', { title: 'x', verificationMode: 'bearer' }, sc);
    expect(r.json.error).toBe('verification_required');
    const long = await h.api('POST', '/api/transfers', { title: 'x', expiresAt: new Date(h.clock.now().getTime() + 400 * 86_400_000).toISOString() }, sc);
    expect(long.json.error).toBe('expiry_too_late');
  });

  it('tightening to "required" upgrades bearer transfers, revokes bearer sessions and is audited with a reason', async () => {
    await setVerificationMode('disabled');
    const s = await h.sendTransfer(sc, { recipients: ['b@example.invalid'] });
    expect(s.detail.verificationMode).toBe('bearer');
    const token = s.tokens['b@example.invalid']!;
    expect((await h.api('GET', `/api/r/${token}`)).json.state).toBe('bearer_ready');
    const open = await h.api('POST', `/api/r/${token}/open`, {});
    expect(open.status).toBe(200);
    expect(open.json.view.recipientEmail).toBeNull(); // never reported as a verified person
    const bearerAudit = (await h.audits(s.id, 'recipient.bearer_access'))[0]!;
    expect(bearerAudit.actor_kind).toBe('anonymous');
    expect((await h.api('GET', `/api/r/${token}/view`, undefined, open.cookie)).status).toBe(200);
    // a bearer download is attributed to an anonymous link holder
    const fileId = s.detail.files[0].id;
    await (await h.raw(`/api/r/${token}/files/${fileId}`, { cookie: open.cookie })).text();
    await new Promise((r) => setTimeout(r, 200));
    const dl = (await h.audits(s.id, 'download.completed'))[0]!;
    expect(dl.actor_kind).toBe('anonymous');
    const withoutReason = await h.api('PUT', '/api/admin/settings/verification', { value: { ...(await h.api('GET', '/api/admin/settings', undefined, ac)).json.settings.verification, mode: 'required' }, reason: '' }, ac);
    expect(withoutReason.json.error).toBe('reason_required');
    await setVerificationMode('required');
    const t = (await h.db.query<{ verification_mode: string; effective_policy: { verificationMode: string } }>(`SELECT verification_mode::text, effective_policy FROM transfers WHERE id = $1`, [s.id])).rows[0]!;
    expect(t.verification_mode).toBe('required');
    expect(t.effective_policy.verificationMode).toBe('required');
    expect((await h.api('GET', `/api/r/${token}/view`, undefined, open.cookie)).status).toBe(401);
    expect((await h.api('GET', `/api/r/${token}`)).json.state).toBe('needs_verification');
    expect((await h.api('POST', `/api/r/${token}/open`, {})).status).toBe(409);
    const cfg = (await h.db.query<{ details: { transfersTightened: number; reason: string; section: string } }>(`SELECT details FROM audit_events WHERE event_type = 'config.changed' ORDER BY id DESC LIMIT 1`)).rows[0]!;
    expect(cfg.details.section).toBe('verification');
    expect(cfg.details.transfersTightened).toBe(1);
    expect(cfg.details.reason).toBe('set required');
    // policy version recorded on new transfers increments
    const v1 = (await h.db.query<{ id: number }>(`SELECT max(id) AS id FROM policy_versions`)).rows[0]!.id;
    expect(v1).toBeGreaterThanOrEqual(2);
  });

  it('loosening the global policy does not weaken existing transfers', async () => {
    const s = await h.sendTransfer(sc, { recipients: ['k@example.invalid'] });
    expect(s.detail.verificationMode).toBe('required');
    await setVerificationMode('disabled');
    const token = s.tokens['k@example.invalid']!;
    expect((await h.api('GET', `/api/r/${token}`)).json.state).toBe('needs_verification');
    expect((await h.api('POST', `/api/r/${token}/open`, {})).status).toBe(409);
    const t = (await h.db.query<{ verification_mode: string }>(`SELECT verification_mode::text FROM transfers WHERE id = $1`, [s.id])).rows[0]!;
    expect(t.verification_mode).toBe('required');
    await setVerificationMode('required');
  });

  it('sender_choice lets a sender choose bearer, which the UI must label; sessions remain bound', async () => {
    await setVerificationMode('sender_choice');
    const def = await h.api('POST', '/api/transfers', { title: 'default' }, sc);
    expect(def.json.verificationMode).toBe('required');
    const bearer = await h.api('POST', '/api/transfers', { title: 'bearer', verificationMode: 'bearer' }, sc);
    expect(bearer.json.verificationMode).toBe('bearer');
    await setVerificationMode('required');
  });

  it('admin cannot lock everyone out, and SSO cannot be enforced before a successful test', async () => {
    const settings = await h.api('GET', '/api/admin/settings', undefined, ac);
    const id = settings.json.settings.identity;
    expect((await h.api('PUT', '/api/admin/settings/identity', { value: { ...id, localLoginEnabled: false, ssoEnabled: false }, reason: 'x' }, ac)).json.error).toBe('lockout');
    expect((await h.api('PUT', '/api/admin/settings/identity', { value: { ...id, ssoEnabled: true, ssoEnforced: true, oidc: { ...id.oidc, issuer: 'https://login.microsoftonline.com/x/v2.0', clientId: 'c' } }, reason: 'x' }, ac)).json.error).toBe('sso_untested');
    // secrets are write-only
    const r = await h.api('PUT', '/api/admin/settings/smtp', { value: { ...settings.json.settings.smtp, host: 'smtp.example.invalid' }, reason: 'x', secrets: { password: 'hunter2-secret' } }, ac);
    expect(r.status).toBe(200);
    const after = await h.api('GET', '/api/admin/settings', undefined, ac);
    expect(after.json.settings.smtp.passwordSet).toBe(true);
    expect(after.text).not.toContain('hunter2');
    const cfg = (await h.db.query<{ details: Record<string, unknown> }>(`SELECT details FROM audit_events WHERE event_type = 'config.changed' ORDER BY id DESC LIMIT 1`)).rows[0]!;
    expect(JSON.stringify(cfg.details)).not.toContain('hunter2');
    expect(cfg.details.updatedSecretFields).toEqual(['password']);
  });

  it('audit retention purges old events, metadata is anonymised after its own retention, and the receipt survives until then', async () => {
    sc = await h.login({ ...(await h.createUser('sender')), mfa: true });
    const s = await h.sendTransfer(sc, { recipients: ['purge@example.invalid'], title: 'Sensitive title' });
    h.clock.advance(8 * 86_400_000);
    await expireSweep(h.ctx);
    await h.runQueuedJobsNow();
    await h.worker.drain();
    // content gone, metadata still readable by the sender
    sc = await h.login({ ...(await h.createUser('sender')), mfa: true });
    const auditor = await h.login(await h.createUser('auditor'));
    const receipt = await h.api('GET', `/api/audit/transfers/${s.id}/receipt`, undefined, auditor);
    expect(receipt.json.transfer.title).toBe('Sensitive title');
    expect(receipt.json.events.length).toBeGreaterThan(5);
    // app code can never modify or delete audit rows
    await expect(h.db.query(`DELETE FROM audit_events WHERE id = (SELECT min(id) FROM audit_events)`)).rejects.toThrow(/append-only/);
    await expect(h.db.query(`UPDATE audit_events SET outcome = 'x' WHERE id = (SELECT min(id) FROM audit_events)`)).rejects.toThrow(/append-only/);
    // metadata retention (90 days after deletion) and audit retention (365 days) are separate settings: at +100 days only metadata is anonymised
    h.clock.advance(100 * 86_400_000);
    const r1 = await purgeAudit(h.ctx);
    expect(r1.anonymised).toBeGreaterThanOrEqual(1);
    expect(r1.purged).toBe(0);
    const t = (await h.db.query<{ title: string; metadata_purged_at: Date | null }>(`SELECT title, metadata_purged_at FROM transfers WHERE id = $1`, [s.id])).rows[0]!;
    expect(t.title).toBe('');
    expect(t.metadata_purged_at).not.toBeNull();
    const g = (await h.db.query<{ email: string }>(`SELECT email::text FROM recipient_grants WHERE transfer_id = $1`, [s.id])).rows[0]!;
    expect(g.email).not.toContain('purge@example.invalid');
    const f = (await h.db.query<{ display_name: string }>(`SELECT display_name FROM transfer_files WHERE transfer_id = $1`, [s.id])).rows[0]!;
    expect(f.display_name).toBe('file');
    const stillThere = await h.api('GET', `/api/audit/transfers/${s.id}/receipt`, undefined, await h.login(await h.createUser('auditor')));
    expect(stillThere.json.events.length).toBeGreaterThan(5); // receipt kept until audit retention
    // Design decision (documented): append-only audit rows keep email-at-event until *audit* retention expires;
    // the live metadata tables (grants, files, titles) are anonymised at *metadata* retention.
    // at +400 days the audit retention purge removes the old events through the SECURITY DEFINER function
    h.clock.advance(300 * 86_400_000);
    const r2 = await purgeAudit(h.ctx);
    expect(r2.purged).toBeGreaterThan(0);
    const gone = await h.api('GET', `/api/audit/transfers/${s.id}/receipt`, undefined, await h.login(await h.createUser('auditor')));
    expect(gone.json.events).toHaveLength(0);
    expect((await h.db.query(`SELECT 1 FROM audit_events WHERE event_type = 'audit.purged'`)).rowCount).toBeGreaterThan(0);
  });
});
