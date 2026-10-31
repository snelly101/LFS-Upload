import { useState } from 'react';
import { formatBytes } from '@snelson/shared';
import { post, get, errorMessage } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { SectionForm, NumField, GiBField, TextField, ListField, Check, useSettings } from './common';
import { prefLabel } from '../TransferDetail';

export function BrandingSection() {
  return (
    <SectionForm
      section="branding"
      title="Branding"
      intro="Shown in the application, on recipient pages and in emails. The accent colour is applied to buttons and links; keep it dark enough for white text (contrast ≥ 4.5:1)."
      render={(d, set) => (
        <>
          <TextField id="b-name" label="Product name" value={d.productName} onChange={(v) => set({ productName: v })} />
          <TextField id="b-org" label="Organisation name" value={d.organisationName} onChange={(v) => set({ organisationName: v })} />
          <TextField id="b-support" label="Support email" type="email" value={d.supportEmail ?? ''} onChange={(v) => set({ supportEmail: v || null })} hint="Shown to recipients on error pages." />
          <TextField id="b-url" label="Support URL" type="url" value={d.supportUrl ?? ''} onChange={(v) => set({ supportUrl: v || null })} />
          <div className="field">
            <label htmlFor="b-accent">Accent colour</label>
            <div className="row"><input id="b-accent" type="color" value={d.accentColour} onChange={(e) => set({ accentColour: e.target.value })} /><code>{d.accentColour}</code><span className="btn btn-sm" style={{ background: d.accentColour, color: '#fff', borderColor: d.accentColour }}>Preview</span></div>
          </div>
          <div className="field">
            <label htmlFor="b-logo">Logo (SVG or PNG, max 150 KB)</label>
            <input id="b-logo" type="file" accept="image/svg+xml,image/png" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; if (f.size > 150_000) return alert('Logo too large'); const r = new FileReader(); r.onload = () => set({ logoDataUrl: String(r.result) }); r.readAsDataURL(f); }} />
            {d.logoDataUrl && <div className="row"><img src={d.logoDataUrl} alt="Current logo" style={{ height: 32 }} /><button type="button" className="btn btn-sm" onClick={() => set({ logoDataUrl: null })}>Remove logo</button></div>}
          </div>
          <TextField id="b-tz" label="Default display time zone" value={d.defaultTimeZone} onChange={(v) => set({ defaultTimeZone: v })} hint="IANA name, e.g. Europe/London. All storage is UTC." />
        </>
      )}
    />
  );
}

export function IdentitySection() {
  const { withStepUp } = useAuth();
  const [test, setTest] = useState<string | null>(null);
  const runTest = () => withStepUp(() => post<{ ok: boolean; issuer?: string; error?: string; note?: string }>('/api/admin/settings/sso/test')).then((r) => setTest(r.ok ? `Discovery succeeded for ${r.issuer}. ${r.note}` : `Failed: ${r.error}`)).catch((e) => setTest(errorMessage(e)));
  return (
    <>
      <SectionForm
        section="identity"
        title="Identity & access"
        sensitive
        intro={<>Configure Microsoft Entra ID (or another OpenID Connect provider) and session limits. See <code>docs/ENTRA-SETUP.md</code> for the app registration steps. Redirect URI: <code>{window.location.origin}/api/auth/sso/callback</code></>}
        impact={<>Enforcing SSO disables local sign-in for everyone, including administrators. Run a successful SSO test and complete a real sign-in in a private window first. Local-account MFA cannot be switched off. Shortening session limits takes effect at each session's next check.</>}
        render={(d, set) => (
          <>
            <Check label="Allow local accounts (password + mandatory MFA)" checked={d.localLoginEnabled} onChange={(v) => set({ localLoginEnabled: v })} />
            <Check label="Enable single sign-on" checked={d.ssoEnabled} onChange={(v) => set({ ssoEnabled: v })} />
            <Check label="Enforce SSO (hide local sign-in)" checked={d.ssoEnforced} onChange={(v) => set({ ssoEnforced: v })} hint="Requires a successful SSO test within the last 7 days." />
            <fieldset>
              <legend>OpenID Connect provider</legend>
              <TextField id="o-label" label="Provider label" value={d.oidc.providerLabel} onChange={(v) => set({ oidc: { ...d.oidc, providerLabel: v } })} />
              <TextField id="o-issuer" label="Issuer URL" value={d.oidc.issuer} onChange={(v) => set({ oidc: { ...d.oidc, issuer: v } })} placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0" hint="Must exactly match the iss claim. Use the tenant-specific v2.0 endpoint, never /common." />
              <TextField id="o-client" label="Client (application) ID" value={d.oidc.clientId} onChange={(v) => set({ oidc: { ...d.oidc, clientId: v } })} />
              <TextField id="o-tenant" label="Tenant ID (tid claim)" value={d.oidc.tenantId} onChange={(v) => set({ oidc: { ...d.oidc, tenantId: v } })} hint="Tokens from any other tenant are rejected." />
              <ListField id="o-users" label="Allowed user object IDs" value={d.oidc.allowedUserObjectIds} onChange={(v) => set({ oidc: { ...d.oidc, allowedUserObjectIds: v } })} hint="Entra object IDs (oid) of individually allowed users." />
              <ListField id="o-groups" label="Allowed group IDs (senders)" value={d.oidc.allowedGroupIds} onChange={(v) => set({ oidc: { ...d.oidc, allowedGroupIds: v } })} hint="Group object IDs. The app registration must emit the groups claim." />
              <ListField id="o-admins" label="Administrator group IDs" value={d.oidc.adminGroupIds} onChange={(v) => set({ oidc: { ...d.oidc, adminGroupIds: v } })} hint="Members get the admin role; roles are re-evaluated at every login." />
              <ListField id="o-auditors" label="Auditor group IDs" value={d.oidc.auditorGroupIds} onChange={(v) => set({ oidc: { ...d.oidc, auditorGroupIds: v } })} hint="Members get the auditor role." />
              <Check label="Require the IdP to report MFA (amr contains 'mfa')" checked={d.oidc.requireAmrMfa} onChange={(v) => set({ oidc: { ...d.oidc, requireAmrMfa: v } })} hint="Entra only reliably emits amr for some flows; prefer a Conditional Access policy that requires MFA for this app, and enable this as an additional check once verified." />
              <TextField id="o-acr" label="acr_values (optional)" value={d.oidc.acrValues} onChange={(v) => set({ oidc: { ...d.oidc, acrValues: v } })} hint="Requested authentication context, if your provider supports it." />
              <TextField id="o-scopes" label="Scopes" value={d.oidc.scopes} onChange={(v) => set({ oidc: { ...d.oidc, scopes: v } })} />
              <p className="small">Client secret: {d.oidc.clientSecretSet ? 'set (never shown)' : 'not set'}</p>
            </fieldset>
            <fieldset>
              <legend>Sessions</legend>
              <NumField id="s-idle" label="Idle timeout (minutes)" value={d.sessionIdleMinutes} min={5} max={1440} onChange={(v) => set({ sessionIdleMinutes: v })} />
              <NumField id="s-abs" label="Absolute session limit (hours)" value={d.sessionAbsoluteHours} min={1} max={168} onChange={(v) => set({ sessionAbsoluteHours: v })} hint="Shorter limits reduce the window in which a disabled IdP account keeps access." />
              <NumField id="s-recent" label="Recent authentication window for sensitive actions (minutes)" value={d.recentAuthMinutes} min={1} max={120} onChange={(v) => set({ recentAuthMinutes: v })} />
            </fieldset>
          </>
        )}
        secretsRender={(s, set) => (
          <div className="field">
            <label htmlFor="o-secret">New client secret (leave blank to keep)</label>
            <input id="o-secret" className="input" type="password" autoComplete="off" value={s.clientSecret ?? ''} onChange={(e) => set('clientSecret', e.target.value)} />
            <span className="hint">Stored encrypted; never returned to the browser.</span>
          </div>
        )}
      />
      <div className="card">
        <h2>Test SSO configuration</h2>
        <p className="small muted">Performs OpenID discovery with the saved settings and records the result. It does not sign anyone in: finish with a real sign-in in a private window before enforcing.</p>
        <button className="btn" onClick={() => void runTest()}>Run discovery test</button>
        {test && <div className="notice notice-info" role="status" style={{ marginTop: 10 }}>{test}</div>}
      </div>
    </>
  );
}

export function TransferPolicySection() {
  const s = useSettings();
  return (
    <SectionForm
      section="transferPolicy"
      title="Transfer policy"
      sensitive
      intro="Maximum permissions for senders. Senders may choose tighter values, never looser."
      impact={<>Tightening limits applies to new uploads immediately. Existing active transfers keep the effective policy recorded when they were sent (shown on each transfer), except that expiry extensions are always checked against the current maximum. The scanner limit is {formatBytes(s.data?.scannerMaxBytes ?? 0, 0)}; larger files cannot be scanned.</>}
      render={(d, set) => (
        <>
          <NumField id="t-def" label="Default expiry (hours)" value={d.defaultExpiryHours} min={1} onChange={(v) => set({ defaultExpiryHours: v })} />
          <NumField id="t-max" label="Maximum expiry (hours after sending)" value={d.maxExpiryHours} min={1} onChange={(v) => set({ maxExpiryHours: v })} />
          <GiBField id="t-file" label="Maximum size per file" value={d.maxFileBytes} onChange={(v) => set({ maxFileBytes: v })} hint="Engineering target 100 GiB; validate against your disk and tested load profile." />
          <GiBField id="t-tr" label="Maximum size per transfer" value={d.maxTransferBytes} onChange={(v) => set({ maxTransferBytes: v })} />
          <NumField id="t-files" label="Maximum files per transfer" value={d.maxFilesPerTransfer} min={1} max={1000} onChange={(v) => set({ maxFilesPerTransfer: v })} />
          <NumField id="t-rcpts" label="Maximum recipients per transfer" value={d.maxRecipientsPerTransfer} min={1} max={200} onChange={(v) => set({ maxRecipientsPerTransfer: v })} />
          <GiBField id="t-uq" label="Default quota per user" value={d.defaultUserQuotaBytes} onChange={(v) => set({ defaultUserQuotaBytes: v })} hint="0 = unlimited. Per-user overrides in Users." />
          <GiBField id="t-oq" label="Organisation quota" value={d.organisationQuotaBytes} onChange={(v) => set({ organisationQuotaBytes: v })} hint="0 = unlimited. Counts stored and reserved (in-flight) bytes." />
          <ListField id="t-allow" label="Allowed file extensions" value={d.allowedExtensions} onChange={(v) => set({ allowedExtensions: v.map((x) => x.toLowerCase().replace(/^\./, '')) })} hint="Empty = all types allowed (except blocked)." />
          <ListField id="t-block" label="Blocked file extensions" value={d.blockedExtensions} onChange={(v) => set({ blockedExtensions: v.map((x) => x.toLowerCase().replace(/^\./, '')) })} hint="Blocked wins over allowed." />
          <ListField id="t-dom" label="Permitted recipient domains" value={d.allowedRecipientDomains} onChange={(v) => set({ allowedRecipientDomains: v.map((x) => x.toLowerCase()) })} hint="Empty = any domain. Subdomains of a listed domain are allowed." />
          <div className="field">
            <label htmlFor="t-dl">Maximum downloads per recipient per file</label>
            <input id="t-dl" className="input" type="number" min={1} value={d.maxDownloadsPerRecipient ?? ''} placeholder="Unlimited" onChange={(e) => set({ maxDownloadsPerRecipient: e.target.value === '' ? null : Number(e.target.value) })} style={{ maxWidth: 240 }} />
            <span className="hint">Senders may set a lower limit on each transfer.</span>
          </div>
          <Check label="Allow senders to extend the expiry of active transfers" checked={d.allowExpiryExtension} onChange={(v) => set({ allowExpiryExtension: v })} hint="Always bounded by the maximum expiry and audited. Deleted content cannot be restored." />
          <Check label="Allow release of files too large for the malware scanner (unscanned)" checked={d.allowUnscannedOversizedRelease} onChange={(v) => set({ allowUnscannedOversizedRelease: v })} hint="Off by default. When on, such files are clearly labelled as not scanned in the sender UI and audit trail." />
        </>
      )}
    />
  );
}

export function VerificationSection() {
  return (
    <SectionForm
      section="verification"
      title="Recipient verification"
      sensitive
      impact={<>Switching to <strong>required</strong> tightens every active transfer immediately: bearer sessions are revoked and recipients must verify. Loosening to sender-selectable or disabled never changes existing transfers; they keep the policy they were sent with.</>}
      render={(d, set) => (
        <>
          <div className="field">
            <label htmlFor="v-mode">Mode</label>
            <select id="v-mode" className="select" value={d.mode} onChange={(e) => set({ mode: e.target.value as typeof d.mode })} style={{ maxWidth: 360 }}>
              <option value="required">Required: every recipient verifies by email code (default)</option>
              <option value="sender_choice">Sender-selectable: senders may disable per transfer</option>
              <option value="disabled">Disabled: all links are bearer links</option>
            </select>
          </div>
          {d.mode !== 'required' && (
            <div className="notice notice-warn"><strong>Bearer links</strong>With verification off, anyone holding a link can download. Recipient identity cannot be verified, downloads are recorded as "link holder (unverified)" and forwarded links grant access. Email verification proves mailbox control at that moment, not a person's identity.</div>
          )}
          <NumField id="v-digits" label="Code length (digits)" value={d.codeDigits} min={6} max={8} onChange={(v) => set({ codeDigits: v })} />
          <NumField id="v-ttl" label="Code validity (seconds)" value={d.codeTtlSeconds} min={60} max={1800} onChange={(v) => set({ codeTtlSeconds: v })} hint="Default 600 (10 minutes)." />
          <NumField id="v-att" label="Maximum attempts per code" value={d.maxAttempts} min={3} max={10} onChange={(v) => set({ maxAttempts: v })} />
          <NumField id="v-cd" label="Resend cooldown (seconds)" value={d.resendCooldownSeconds} min={30} max={600} onChange={(v) => set({ resendCooldownSeconds: v })} />
          <NumField id="v-g" label="Max codes per recipient per hour" value={d.maxCodesPerGrantPerHour} min={3} max={30} onChange={(v) => set({ maxCodesPerGrantPerHour: v })} />
          <NumField id="v-t" label="Max codes per transfer per hour" value={d.maxCodesPerTransferPerHour} min={10} max={500} onChange={(v) => set({ maxCodesPerTransferPerHour: v })} />
          <NumField id="v-s" label="Max codes per source network per hour" value={d.maxCodesPerSourcePerHour} min={5} max={200} onChange={(v) => set({ maxCodesPerSourcePerHour: v })} hint="Source is a /24 (IPv4) or /48 (IPv6) prefix." />
          <NumField id="v-sess" label="Recipient session length (minutes)" value={d.recipientSessionMinutes} min={5} max={1440} onChange={(v) => set({ recipientSessionMinutes: v })} hint="Verification is never permanent; sessions also end at transfer expiry or revocation." />
        </>
      )}
    />
  );
}

export function NotificationsSection() {
  const { withStepUp } = useAuth();
  const [to, setTo] = useState('');
  const [res, setRes] = useState<string | null>(null);
  const [kind, setKind] = useState('transfer_available');
  const [preview, setPreview] = useState<{ subject: string; text: string; html: string } | null>(null);
  const kinds = ['transfer_available', 'verification_code', 'sender_activity', 'expiring_soon_recipient', 'account_invite', 'password_reset', 'security_notice', 'admin_alert', 'test_message'];
  const sendTest = () => withStepUp(() => post<{ ok: boolean; response?: string; error?: string }>('/api/admin/settings/smtp/test', { to })).then((r) => setRes(r.ok ? `Accepted by server: ${r.response}` : `Failed: ${r.error}`)).catch((e) => setRes(errorMessage(e)));
  return (
    <>
      <SectionForm
        section="notifications"
        title="Notification policy"
        render={(d, set) => (
          <>
            <fieldset>
              <legend>Which choices senders have, and the default for new transfers</legend>
              {Object.keys(d.defaults).map((k) => (
                <div className="row" key={k} style={{ marginBottom: 6 }}>
                  <span style={{ minWidth: 220 }}>{prefLabel(k).charAt(0).toUpperCase() + prefLabel(k).slice(1)}</span>
                  <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={(d.senderChoices as Record<string, boolean>)[k]} onChange={(e) => set({ senderChoices: { ...d.senderChoices, [k]: e.target.checked } })} /><span>Sender may choose</span></label>
                  <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={(d.defaults as Record<string, boolean>)[k]} onChange={(e) => set({ defaults: { ...d.defaults, [k]: e.target.checked } })} /><span>Default on</span></label>
                </div>
              ))}
            </fieldset>
            <NumField id="n-lead" label="Expiring-soon lead time (hours)" value={d.expiringSoonLeadHours} min={1} max={168} onChange={(v) => set({ expiringSoonLeadHours: v })} />
            <Check label="Remind outstanding recipients before expiry" checked={d.remindOutstandingRecipients} onChange={(v) => set({ remindOutstandingRecipients: v })} hint="Sends a reminder email (with a fresh link) to recipients who have not downloaded everything." />
            <Check label="Email senders on scan or upload failure (in-app notice is always created)" checked={d.scanFailureEmail} onChange={(v) => set({ scanFailureEmail: v })} />
            <ListField id="n-admins" label="Operational alert recipients" value={d.adminAlertEmails} onChange={(v) => set({ adminAlertEmails: v })} hint="Empty = all active administrators." />
          </>
        )}
      />
      <SectionForm
        section="smtp"
        title="SMTP"
        intro="Outbound email settings. Leave the host blank to use SMTP_URL from the environment."
        render={(d, set) => (
          <>
            <TextField id="m-host" label="Host" value={d.host} onChange={(v) => set({ host: v })} />
            <NumField id="m-port" label="Port" value={d.port} min={1} max={65535} onChange={(v) => set({ port: v })} />
            <Check label="Implicit TLS (port 465)" checked={d.secure} onChange={(v) => set({ secure: v })} hint="Otherwise STARTTLS is negotiated when offered." />
            <TextField id="m-user" label="Username" value={d.username} onChange={(v) => set({ username: v })} />
            <TextField id="m-from" label="From address" value={d.from} onChange={(v) => set({ from: v })} placeholder="Snelson Send <send@example.com>" />
            <TextField id="m-reply" label="Reply-to (optional)" value={d.replyTo} onChange={(v) => set({ replyTo: v })} />
            <p className="small">Password: {d.passwordSet ? 'set (never shown)' : 'not set'}</p>
          </>
        )}
        secretsRender={(s, set) => (
          <div className="field"><label htmlFor="m-pw">New password (leave blank to keep)</label><input id="m-pw" className="input" type="password" autoComplete="off" value={s.password ?? ''} onChange={(e) => set('password', e.target.value)} /></div>
        )}
      />
      <div className="card">
        <h2>Test email and template preview</h2>
        <div className="row">
          <label htmlFor="t-to" className="visually-hidden">Send test to</label>
          <input id="t-to" className="input" type="email" placeholder="Send a test message to…" value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 320 }} />
          <button className="btn" onClick={() => void sendTest()} disabled={!to}>Send test</button>
        </div>
        {res && <div className="notice notice-info" role="status" style={{ marginTop: 10 }}>{res}</div>}
        <hr className="divider" />
        <div className="row">
          <label htmlFor="t-kind">Template</label>
          <select id="t-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 260 }}>{kinds.map((k) => <option key={k} value={k}>{k}</option>)}</select>
          <button className="btn" onClick={() => void get<{ subject: string; text: string; html: string }>(`/api/admin/templates/${kind}`).then(setPreview)}>Preview with sample data</button>
        </div>
        {preview && (
          <div style={{ marginTop: 12 }}>
            <p><strong>Subject:</strong> {preview.subject}</p>
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 420, border: '1px solid var(--border)', borderRadius: 4, background: '#fff' }} />
            <details><summary className="small">Plain-text version</summary><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{preview.text}</pre></details>
          </div>
        )}
      </div>
    </>
  );
}

export function StorageSection() {
  return (
    <SectionForm
      section="storage"
      title="Storage & deletion"
      sensitive
      intro={<>Content lives on the encrypted content volume only. Deletion jobs are durable and verified; a reconciliation sweep runs hourly and at worker start. See <code>docs/RUNBOOK.md</code> for disk layout and encryption prerequisites.</>}
      render={(d, set) => (
        <>
          <NumField id="st-target" label="Deletion target after expiry (minutes)" value={d.deletionTargetMinutes} min={1} max={1440} onChange={(v) => set({ deletionTargetMinutes: v })} hint="Overdue deletions raise an operational alert. An offline server cannot delete until it returns." />
          <NumField id="st-aband" label="Abandon inactive uploads after (hours)" value={d.abandonedUploadHours} min={1} onChange={(v) => set({ abandonedUploadHours: v })} hint="Partial data is deleted and the quota reservation released." />
          <NumField id="st-draft" label="Discard unsent drafts after (days)" value={d.draftTransferDays} min={1} onChange={(v) => set({ draftTransferDays: v })} />
          <NumField id="st-warn" label="Low disk warning (% free)" value={d.lowDiskWarnPercent} min={1} max={99} onChange={(v) => set({ lowDiskWarnPercent: v })} />
          <NumField id="st-crit" label="Low disk critical (% free)" value={d.lowDiskCriticalPercent} min={1} max={99} onChange={(v) => set({ lowDiskCriticalPercent: v })} hint="New uploads are refused when accepting them would leave less than this free." />
        </>
      )}
    />
  );
}

export function AuditSection() {
  return (
    <SectionForm
      section="audit"
      title="Audit & privacy"
      sensitive
      intro="Content expiry and audit retention are separate. After content deletion plus the metadata retention period, filenames, recipient addresses, titles and messages are anonymised while the event receipt is kept until audit retention expires."
      impact={<>Shortening retention purges older records at the next daily run. This application does not make you GDPR-compliant by itself: document your lawful basis, retention decisions and recipient privacy notice (see <code>docs/PRIVACY-OPERATIONS.md</code>).</>}
      render={(d, set) => (
        <>
          <NumField id="a-ret" label="Audit retention (days)" value={d.auditRetentionDays} min={30} max={3650} onChange={(v) => set({ auditRetentionDays: v })} />
          <NumField id="a-meta" label="Metadata retention after content deletion (days)" value={d.metadataRetentionDays} min={1} max={3650} onChange={(v) => set({ metadataRetentionDays: v })} />
          <Check label="Auditors may see recipient email addresses" checked={d.auditorsSeeRecipientEmails} onChange={(v) => set({ auditorsSeeRecipientEmails: v })} hint="When off, auditors see recipients as '[recipient]'." />
        </>
      )}
    />
  );
}
