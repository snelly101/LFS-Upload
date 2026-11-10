import { useEffect, useState } from 'react';
import { formatBytes, type Branding } from '@securesend/shared';
import { post, get, errorMessage } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { applyBrand, deriveAccent, PREVIEW, type Scheme } from '../../lib/theme';
import { SectionForm, Group, NumField, DurationField, SizeField, TextField, ListField, Check, Choice, Segmented, useSettings } from './common';

// ---------------------------------------------------------------------------------------- branding
/** Applies the draft look to this page while it is being edited, and puts the saved look back afterwards. */
function LiveBrand({ d }: { d: Branding }) {
  const { options } = useAuth();
  useEffect(() => {
    applyBrand({ theme: d.theme, colourScheme: d.colourScheme, accentColour: d.accentColour }, false);
  }, [d.theme, d.colourScheme, d.accentColour]);
  useEffect(
    () => () => {
      if (options) applyBrand({ theme: options.theme, colourScheme: options.colourScheme, accentColour: options.accentColour }, false);
    },
    [options],
  );
  return null;
}

function AccentPreview({ d }: { d: Branding }) {
  const panes = (['light', 'dark'] as Scheme[]).map((scheme) => ({ scheme, a: deriveAccent(d.accentColour, d.theme, scheme), p: PREVIEW[d.theme][scheme] }));
  const adjusted = panes.filter((x) => x.a.adjusted);
  return (
    <>
      <div className="preview-pair" aria-label="Accent colour preview">
        {panes.map(({ scheme, a, p }) => (
          <div key={scheme} className="preview-pane" style={{ background: p.surface, color: p.ink, borderColor: p.line, fontFamily: p.text }}>
            <div style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: p.muted, marginBottom: 6 }}>{scheme} mode</div>
            <div style={{ fontFamily: p.display, fontSize: '1.15rem', fontWeight: 600, marginBottom: 8 }}>Send files securely</div>
            <span className="pv-btn" style={{ background: a.accent, color: a.onAccent }}>Choose files</span>
            <div style={{ marginTop: 10, fontSize: '0.9rem' }}>
              <span style={{ color: a.accentInk, textDecoration: 'underline' }}>A link</span>
              <span style={{ color: p.muted }}> · button text contrast {a.fillContrast.toFixed(1)}:1</span>
            </div>
          </div>
        ))}
      </div>
      {adjusted.length > 0 && (
        <div className="notice notice-warn" style={{ marginTop: 10, maxWidth: 560 }} role="status">
          <strong>This colour is adjusted to stay readable</strong>
          {adjusted.map(({ scheme, a }) => (
            <div key={scheme}>In {scheme} mode buttons use {a.accent} instead of {d.accentColour.toLowerCase()} so they stand out from the page.</div>
          ))}
        </div>
      )}
    </>
  );
}

export function BrandingSection() {
  const [logoErr, setLogoErr] = useState<string | null>(null);
  return (
    <SectionForm
      section="branding"
      title="Branding"
      intro="How the service looks to staff and to the people who receive files. Changes preview on this page straight away and apply everywhere once saved."
      render={(d, set) => (
        <>
          <LiveBrand d={d} />
          <Group title="Names" note="The product name appears in the header, on recipient pages and in every email.">
            <TextField id="b-name" label="Product name" value={d.productName} onChange={(v) => set({ productName: v })} />
            <TextField id="b-org" label="Organisation name" value={d.organisationName} onChange={(v) => set({ organisationName: v })} hint="Shown above the product name and in email footers. If the product name starts with it, the header shows the two on separate lines." />
          </Group>
          <Group title="Logo" note="Used in the header and on recipient pages. Without one, a monogram is drawn from the organisation's initials.">
            <div className="field">
              <label htmlFor="b-logo">Upload a logo <span className="muted" style={{ fontWeight: 400 }}>SVG or PNG, up to 150 KB</span></label>
              <input
                id="b-logo"
                type="file"
                accept="image/svg+xml,image/png"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 150_000) return setLogoErr(`${f.name} is ${Math.round(f.size / 1000)} KB. Please use a file under 150 KB.`);
                  setLogoErr(null);
                  const r = new FileReader();
                  r.onload = () => set({ logoDataUrl: String(r.result) });
                  r.readAsDataURL(f);
                }}
              />
              {logoErr && <span className="hint" role="alert" style={{ color: 'var(--err)' }}>{logoErr}</span>}
              {d.logoDataUrl && (
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="swatch"><img src={d.logoDataUrl} alt="Current logo" style={{ height: 32 }} /></span>
                  <button type="button" className="btn btn-sm" onClick={() => set({ logoDataUrl: null })}>Remove logo</button>
                </div>
              )}
            </div>
          </Group>
          <Group title="Look" note="Two designs are built in. Civic is warm and editorial with serif headings; Clear is cool and plain. Try both here before saving.">
            <Segmented legend="Design" value={d.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'civic', label: 'Civic' }, { value: 'clear', label: 'Clear' }]} />
            <Segmented legend="Light or dark" value={d.colourScheme} onChange={(v) => set({ colourScheme: v })} options={[{ value: 'auto', label: "Follow each person's device" }, { value: 'light', label: 'Always light' }, { value: 'dark', label: 'Always dark' }]} />
            <div className="field">
              <label htmlFor="b-accent">Accent colour</label>
              <div className="row">
                <input id="b-accent" type="color" value={d.accentColour} onChange={(e) => set({ accentColour: e.target.value })} style={{ width: 48, height: 38, padding: 2 }} />
                <input className="input mono" aria-label="Accent colour as hex" value={d.accentColour} onChange={(e) => /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && set({ accentColour: e.target.value })} style={{ maxWidth: 120 }} />
              </div>
              <span className="hint">Used for buttons, links and highlights. Your brand's primary colour usually works.</span>
            </div>
            {/^#[0-9a-fA-F]{6}$/.test(d.accentColour) && <AccentPreview d={d} />}
          </Group>
          <Group title="Help and time">
            <TextField id="b-support" label="Support email" type="email" value={d.supportEmail ?? ''} onChange={(v) => set({ supportEmail: v || null })} hint="Shown to recipients and on the sign-in page so people know who to ask." />
            <TextField id="b-url" label="Support web page" type="url" value={d.supportUrl ?? ''} onChange={(v) => set({ supportUrl: v || null })} placeholder="https://" />
            <TextField id="b-tz" label="Time zone for dates" value={d.defaultTimeZone} onChange={(v) => set({ defaultTimeZone: v })} hint="Dates in emails and on recipient pages use this zone, e.g. Europe/London. Everything is stored in UTC." />
          </Group>
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------------------------------- identity
export function IdentitySection() {
  const { withStepUp } = useAuth();
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await withStepUp(() => post<{ ok: boolean; issuer?: string; error?: string; note?: string }>('/api/admin/settings/sso/test'));
      setTest(r.ok ? { ok: true, text: `Discovery succeeded for ${r.issuer}. ${r.note ?? ''}` } : { ok: false, text: `Failed: ${r.error}` });
    } catch (e) {
      setTest({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <SectionForm
        section="identity"
        title="Who can sign in"
        sensitive
        intro="Staff sign in with your identity provider, with a local account, or either. Local accounts always need a second factor; that cannot be switched off."
        impact={<>Turning on "single sign-on only" hides local sign-in for everyone, administrators included. It is refused unless a connection test has succeeded in the last 7 days, and one sign-in method always stays on. Shorter session limits apply to existing sessions at their next request.</>}
        render={(d, set) => (
          <>
            <Group title="Ways to sign in">
              <Check label="Single sign-on" checked={d.ssoEnabled} onChange={(v) => set({ ssoEnabled: v })} hint="Staff use their normal work account (Microsoft Entra ID or another OpenID Connect provider)." />
              <Check label="Local accounts" checked={d.localLoginEnabled} onChange={(v) => set({ localLoginEnabled: v })} hint="Invited by an administrator; password plus a passkey or authenticator app. Keep at least one as a break-glass administrator." />
              <Check label="Single sign-on only" checked={d.ssoEnforced} onChange={(v) => set({ ssoEnforced: v })} hint="Hides local sign-in. Test the connection and complete a real sign-in in a private window first." />
            </Group>
            <Group title="Identity provider" note={<>Register this address as the redirect URI: <code>{window.location.origin}/api/auth/sso/callback</code></>}>
              <TextField id="o-label" label="Name on the sign-in button" value={d.oidc.providerLabel} onChange={(v) => set({ oidc: { ...d.oidc, providerLabel: v } })} />
              <TextField id="o-issuer" label="Issuer address" mono value={d.oidc.issuer} onChange={(v) => set({ oidc: { ...d.oidc, issuer: v.trim() } })} placeholder="https://login.microsoftonline.com/<tenant-id>/v2.0" hint="For Entra use the tenant-specific v2.0 address, never /common. It must match the token's issuer exactly." />
              <TextField id="o-client" label="Application (client) ID" mono value={d.oidc.clientId} onChange={(v) => set({ oidc: { ...d.oidc, clientId: v.trim() } })} />
              <TextField id="o-tenant" label="Directory (tenant) ID" mono value={d.oidc.tenantId} onChange={(v) => set({ oidc: { ...d.oidc, tenantId: v.trim() } })} hint="Sign-ins from any other tenant are refused." />
              <p className="small" style={{ margin: '0 0 6px' }}>Client secret: <strong>{d.oidc.clientSecretSet ? 'saved' : 'not set'}</strong> <span className="muted">(never shown again once saved)</span></p>
            </Group>
          </>
        )}
        secretsRender={(s, set) => (
          <div className="field">
            <label htmlFor="o-secret">New client secret</label>
            <input id="o-secret" className="input" type="password" autoComplete="off" value={s.clientSecret ?? ''} onChange={(e) => set('clientSecret', e.target.value)} />
            <span className="hint">Leave empty to keep the current one. Stored encrypted and never sent back to a browser.</span>
          </div>
        )}
      />
      <SectionForm
        section="identity"
        title="Who is allowed in, and as what"
        sensitive
        intro="Nobody gets in because of their email domain. A person must be in one of these lists, which use object IDs from your directory."
        render={(d, set) => (
          <>
            <Group title="People">
              <ListField id="o-groups" label="Groups whose members can send files" mono value={d.oidc.allowedGroupIds} onChange={(v) => set({ oidc: { ...d.oidc, allowedGroupIds: v } })} hint="Group object IDs. The app registration must include the groups claim in ID tokens." emptyMeans="No group grants sender access." />
              <ListField id="o-admins" label="Groups whose members are administrators" mono value={d.oidc.adminGroupIds} onChange={(v) => set({ oidc: { ...d.oidc, adminGroupIds: v } })} hint="Checked at every sign-in, so removing someone from the group removes the role." />
              <ListField id="o-auditors" label="Groups whose members are auditors" mono value={d.oidc.auditorGroupIds} onChange={(v) => set({ oidc: { ...d.oidc, auditorGroupIds: v } })} hint="Auditors read the activity log; they cannot send or open files." />
              <ListField id="o-users" label="Individual people allowed without a group" mono value={d.oidc.allowedUserObjectIds} onChange={(v) => set({ oidc: { ...d.oidc, allowedUserObjectIds: v } })} hint="User object IDs." />
            </Group>
            <Group title="Proof of multi-factor sign-in" note="The service cannot see how someone signed in at your identity provider; it only knows what the token reports. Require MFA with a Conditional Access policy for this application.">
              <Check label="Refuse sign-ins whose token does not report MFA" checked={d.oidc.requireAmrMfa} onChange={(v) => set({ oidc: { ...d.oidc, requireAmrMfa: v } })} hint="Check a test sign-in in the activity log first: some methods do not report this even when MFA happened." />
              <TextField id="o-acr" label="Authentication context to request" mono value={d.oidc.acrValues} onChange={(v) => set({ oidc: { ...d.oidc, acrValues: v } })} hint="Optional. Only if your provider uses acr_values." />
              <TextField id="o-scopes" label="Scopes" mono value={d.oidc.scopes} onChange={(v) => set({ oidc: { ...d.oidc, scopes: v } })} />
            </Group>
            <Group title="How long people stay signed in" note="Shorter limits shrink the window in which someone disabled at the identity provider still has a working session here.">
              <DurationField id="s-idle" label="Sign out after no activity for" stored="minutes" units={['minutes', 'hours']} value={d.sessionIdleMinutes} min={5} max={1440} onChange={(v) => set({ sessionIdleMinutes: v })} />
              <DurationField id="s-abs" label="Always sign out after" stored="hours" units={['hours', 'days']} value={d.sessionAbsoluteHours} min={1} max={168} onChange={(v) => set({ sessionAbsoluteHours: v })} />
              <DurationField id="s-recent" label="Ask for the second factor again before sensitive changes if it was last checked more than" stored="minutes" units={['minutes', 'hours']} value={d.recentAuthMinutes} min={1} max={120} onChange={(v) => set({ recentAuthMinutes: v })} hint="ago." />
            </Group>
          </>
        )}
      />
      <div className="card settings">
        <h2>Test the connection</h2>
        <p className="intro">Checks that the saved issuer address answers and matches. It does not sign anyone in, so finish with a real sign-in in a private window before turning on "single sign-on only".</p>
        <button className="btn" onClick={() => void runTest()} disabled={testing}>{testing ? 'Testing…' : 'Run connection test'}</button>
        {test && <div className={`notice ${test.ok ? 'notice-ok' : 'notice-err'}`} role="status" style={{ marginTop: 12 }}>{test.text}</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------- transfer policy
const cleanExt = (x: string) => x.toLowerCase().replace(/^\./, '');

export function TransferPolicySection() {
  const s = useSettings();
  const scanner = s.data?.scannerMaxBytes ?? 0;
  return (
    <SectionForm
      section="transferPolicy"
      title="What can be sent"
      sensitive
      intro="These are the outer limits. Senders can choose something stricter for a transfer, never looser."
      impact={<>Tighter limits apply to new uploads immediately. Transfers already sent keep the rules they were sent with, except that extending an expiry is always checked against the current maximum.</>}
      render={(d, set) => {
        const effective = d.allowUnscannedOversizedRelease ? d.maxFileBytes : Math.min(d.maxFileBytes, scanner || d.maxFileBytes);
        return (
          <>
            <Group title="How long files stay available" note="When the time is up, access stops at once and the files are deleted.">
              <DurationField id="t-def" label="Suggested to senders" stored="hours" units={['hours', 'days']} value={d.defaultExpiryHours} onChange={(v) => set({ defaultExpiryHours: v })} />
              <DurationField id="t-max" label="Longest a sender can choose" stored="hours" units={['hours', 'days']} value={d.maxExpiryHours} onChange={(v) => set({ maxExpiryHours: v })} hint="Counted from the moment of sending." />
              <Check label="Senders may extend a live transfer" checked={d.allowExpiryExtension} onChange={(v) => set({ allowExpiryExtension: v })} hint="Never past the longest allowed, always with a reason in the audit log. Deleted files cannot be brought back." />
            </Group>
            <Group title="Size" note={scanner ? <>The malware scanner can check files up to <strong>{formatBytes(scanner, 0)}</strong>.</> : undefined}>
              <SizeField id="t-file" label="Largest single file" value={d.maxFileBytes} onChange={(v) => set({ maxFileBytes: v })} />
              {scanner > 0 && d.maxFileBytes > scanner && (
                <div className={`notice ${d.allowUnscannedOversizedRelease ? 'notice-warn' : 'notice-info'}`} style={{ maxWidth: 560 }}>
                  <strong>{d.allowUnscannedOversizedRelease ? 'Files over the scanner limit will go out unscanned' : `Senders are limited to ${formatBytes(effective, 0)} per file`}</strong>
                  {d.allowUnscannedOversizedRelease
                    ? `Anything between ${formatBytes(scanner, 0)} and ${formatBytes(d.maxFileBytes, 0)} is released without a malware scan and labelled as not scanned.`
                    : `Larger files cannot be scanned, so they are refused before upload. To send bigger files, raise the scanner limit on the server or allow unscanned files below.`}
                </div>
              )}
              <Check label="Allow files too large for the malware scanner" checked={d.allowUnscannedOversizedRelease} onChange={(v) => set({ allowUnscannedOversizedRelease: v })} hint="Off by default. When on, such files are sent without a scan and marked as not scanned for the sender and in the audit log." />
              <SizeField id="t-tr" label="Largest transfer in total" value={d.maxTransferBytes} onChange={(v) => set({ maxTransferBytes: v })} />
              <NumField id="t-files" label="Most files in one transfer" value={d.maxFilesPerTransfer} min={1} max={1000} onChange={(v) => set({ maxFilesPerTransfer: v })} />
            </Group>
            <Group title="Storage allowances" note="Counts files that are stored or part-way through uploading. Space is freed when transfers expire.">
              <SizeField id="t-uq" label="Each sender" value={d.defaultUserQuotaBytes} onChange={(v) => set({ defaultUserQuotaBytes: v })} zeroMeans="No limit" hint="Can be changed per person under People." />
              <SizeField id="t-oq" label="Everyone combined" value={d.organisationQuotaBytes} onChange={(v) => set({ organisationQuotaBytes: v })} zeroMeans="No limit" />
            </Group>
            <Group title="Recipients">
              <NumField id="t-rcpts" label="Most recipients on one transfer" value={d.maxRecipientsPerTransfer} min={1} max={200} onChange={(v) => set({ maxRecipientsPerTransfer: v })} />
              <ListField id="t-dom" label="Only allow recipients at these email domains" value={d.allowedRecipientDomains} onChange={(v) => set({ allowedRecipientDomains: v })} normalise={(x) => x.toLowerCase().replace(/^@/, '')} emptyMeans="Any domain is allowed." hint="Subdomains of a listed domain are allowed too." />
              <div className="field">
                <label htmlFor="t-dl">Most times each recipient can download each file</label>
                <div className="unit-field">
                  <input id="t-dl" className="input" type="number" min={1} value={d.maxDownloadsPerRecipient ?? ''} placeholder="No limit" onChange={(e) => set({ maxDownloadsPerRecipient: e.target.value === '' ? null : Math.max(1, Number(e.target.value)) })} />
                </div>
                <span className="hint">Leave empty for no limit. Resuming an interrupted download does not use another go.</span>
              </div>
            </Group>
            <Group title="File types" note="Checked on the file's extension when it is added.">
              <ListField id="t-block" label="Never allow" mono value={d.blockedExtensions} onChange={(v) => set({ blockedExtensions: v })} normalise={cleanExt} hint="Blocked always wins." />
              <ListField id="t-allow" label="Only allow" mono value={d.allowedExtensions} onChange={(v) => set({ allowedExtensions: v })} normalise={cleanExt} emptyMeans="Every type is allowed except those blocked above." />
            </Group>
          </>
        );
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------- verification
export function VerificationSection() {
  return (
    <SectionForm
      section="verification"
      title="How recipients prove who they are"
      sensitive
      intro="Before anyone outside sees a file name or downloads anything, the service can email a one-time code to the address the transfer was sent to."
      impact={<>Choosing "always" tightens every live transfer immediately: links that needed no code now need one and open sessions are ended. Loosening never changes transfers that have already been sent.</>}
      render={(d, set) => (
        <>
          <Choice
            legend="Email code"
            value={d.mode}
            onChange={(v) => set({ mode: v })}
            options={[
              { value: 'required', label: 'Always required', hint: 'Recommended. A forwarded link is useless without access to the original mailbox.' },
              { value: 'sender_choice', label: 'Sender decides for each transfer', hint: 'Required unless the sender turns it off.' },
              { value: 'disabled', label: 'Never: links open without a code', hint: 'Anyone who gets hold of a link can download.' },
            ]}
          />
          {d.mode !== 'required' && (
            <div className="notice notice-warn" style={{ maxWidth: 620 }}>
              <strong>Links without a code are bearer links</strong>
              Whoever holds the link can download, forwarded links work, and downloads are recorded as "link holder (unverified)" rather than as a named person. A code proves control of a mailbox at that moment; it never proves a person's identity.
            </div>
          )}
          <Group title="The code" note="Sensible defaults are 6 digits, valid for 10 minutes, 5 tries.">
            <NumField id="v-digits" label="Length" value={d.codeDigits} min={6} max={8} onChange={(v) => set({ codeDigits: v })} suffix="digits" />
            <DurationField id="v-ttl" label="Valid for" stored="seconds" units={['seconds', 'minutes']} value={d.codeTtlSeconds} min={60} max={1800} onChange={(v) => set({ codeTtlSeconds: v })} />
            <NumField id="v-att" label="Wrong tries before the code is cancelled" value={d.maxAttempts} min={3} max={10} onChange={(v) => set({ maxAttempts: v })} />
            <DurationField id="v-sess" label="After a correct code, keep the page open for" stored="minutes" units={['minutes', 'hours']} value={d.recipientSessionMinutes} min={5} max={1440} onChange={(v) => set({ recipientSessionMinutes: v })} hint="Never longer than the transfer itself." />
          </Group>
          <Group title="Protection against misuse" note="Stops someone using the service to flood a mailbox with codes.">
            <DurationField id="v-cd" label="Wait between codes to the same recipient" stored="seconds" units={['seconds', 'minutes']} value={d.resendCooldownSeconds} min={30} max={600} onChange={(v) => set({ resendCooldownSeconds: v })} />
            <NumField id="v-g" label="Codes per recipient" value={d.maxCodesPerGrantPerHour} min={3} max={30} onChange={(v) => set({ maxCodesPerGrantPerHour: v })} suffix="per hour" />
            <NumField id="v-t" label="Codes per transfer" value={d.maxCodesPerTransferPerHour} min={10} max={500} onChange={(v) => set({ maxCodesPerTransferPerHour: v })} suffix="per hour" />
            <NumField id="v-s" label="Codes requested from one network" value={d.maxCodesPerSourcePerHour} min={5} max={200} onChange={(v) => set({ maxCodesPerSourcePerHour: v })} suffix="per hour" hint="A network is the first three parts of an IPv4 address (/24), or a /48 for IPv6." />
          </Group>
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------------------------------- notifications
const NOTIFY_LABELS: Record<string, [string, string]> = {
  firstVerifiedView: ['A recipient opens it for the first time', 'After verifying; a bare link fetch does not count.'],
  firstDownload: ['The first download, and when someone has everything', ''],
  everyDownload: ['Every completed download', 'One email per recipient and file.'],
  expiringSoon: ['It is about to expire with downloads outstanding', ''],
  expiredWithoutDownload: ['It expired and nobody downloaded', ''],
  deletionCompleted: ['The files have been deleted', ''],
};
const TEMPLATE_LABELS: Record<string, string> = {
  transfer_available: 'Invitation to a recipient',
  verification_code: 'Verification code',
  sender_activity: 'Activity notice to a sender',
  expiring_soon_recipient: 'Reminder to a recipient',
  account_invite: 'Invitation to a new member of staff',
  password_reset: 'Password reset',
  security_notice: 'Account security notice',
  admin_alert: 'Operational alert to administrators',
  test_message: 'Test message',
};

export function NotificationsSection() {
  const { withStepUp } = useAuth();
  const [to, setTo] = useState('');
  const [res, setRes] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [kind, setKind] = useState('transfer_available');
  const [preview, setPreview] = useState<{ subject: string; text: string; html: string } | null>(null);
  const sendTest = async () => {
    setTesting(true);
    setRes('Connecting to the mail server… this can take up to 45 seconds if the connection is being blocked.');
    try {
      const r = await withStepUp(() => post<{ ok: boolean; response?: string; error?: string }>('/api/admin/settings/smtp/test', { to }));
      setRes(r.ok ? `Accepted by the mail server: ${r.response ?? 'OK'}. Check the inbox (and spam folder) of ${to}.` : `Failed: ${r.error}`);
    } catch (e) {
      setRes(`Failed: ${errorMessage(e)}`);
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <SectionForm
        section="smtp"
        title="Outgoing email"
        intro="Invitations, verification codes and notices all go out through this mail server. Nothing works without it."
        render={(d, set) => (
          <>
            <Group title="Mail server" note="Leave the server name empty to use the SMTP_URL set on the server itself.">
              <TextField id="m-host" label="Server name" mono value={d.host} onChange={(v) => set({ host: v.trim() })} placeholder="mail.example.com" />
              <NumField id="m-port" label="Port" value={d.port} min={1} max={65535} onChange={(v) => set({ port: v })} hint="Usually 587 or 2525, or 465 with the option below." />
              <Check label="Connect with TLS from the start (port 465)" checked={d.secure} onChange={(v) => set({ secure: v })} hint="Leave off for ports 587 and 2525, which upgrade to TLS after connecting." />
              <TextField id="m-user" label="Username" value={d.username} onChange={(v) => set({ username: v })} />
              <p className="small" style={{ margin: '0 0 6px' }}>Password: <strong>{d.passwordSet ? 'saved' : 'not set'}</strong> <span className="muted">(never shown again once saved)</span></p>
            </Group>
          </>
        )}
        secretsRender={(s, set) => (
          <>
            <div className="field"><label htmlFor="m-pw">New password</label><input id="m-pw" className="input" type="password" autoComplete="off" value={s.password ?? ''} onChange={(e) => set('password', e.target.value)} /><span className="hint">Leave empty to keep the current one.</span></div>
          </>
        )}
      />
      <SectionForm
        section="smtp"
        title="Who emails appear to come from"
        intro="Use an address on a domain whose SPF and DKIM records cover the mail server above, or messages are likely to land in spam."
        render={(d, set) => (
          <>
            <TextField id="m-from" label="From" value={d.from} onChange={(v) => set({ from: v })} placeholder="Secure File Send <securesend@example.org>" />
            <TextField id="m-reply" label="Replies go to" value={d.replyTo} onChange={(v) => set({ replyTo: v })} hint="Optional." />
          </>
        )}
      />
      <div className="card settings">
        <h2>Send a test</h2>
        <p className="intro">Sends one message through the saved settings and reports what the mail server said.</p>
        <div className="row">
          <label htmlFor="t-to" className="visually-hidden">Send a test message to</label>
          <input id="t-to" className="input" type="email" placeholder="you@example.org" value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 320 }} />
          <button className="btn" onClick={() => void sendTest()} disabled={!to || testing}>{testing ? 'Sending…' : 'Send test'}</button>
        </div>
        {res && <div className={`notice ${res.startsWith('Failed') ? 'notice-err' : 'notice-info'}`} role="status" style={{ marginTop: 12 }}>{res}</div>}
      </div>
      <SectionForm
        section="notifications"
        title="What senders are told"
        intro="For each event, decide whether senders can choose for themselves and what happens when they don't. Notices inside the app are always recorded."
        render={(d, set) => (
          <>
            <div className="table-wrap" style={{ maxWidth: 760 }}>
              <table className="table">
                <thead><tr><th scope="col">Email the sender when…</th><th scope="col">Sender can choose</th><th scope="col">On unless changed</th></tr></thead>
                <tbody>
                  {Object.keys(d.defaults).map((k) => {
                    const [label, note] = NOTIFY_LABELS[k] ?? [k, ''];
                    return (
                      <tr key={k}>
                        <th scope="row" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 'inherit', color: 'var(--ink)', whiteSpace: 'normal', fontWeight: 600 }}>{label}{note && <div className="small muted" style={{ fontWeight: 400 }}>{note}</div>}</th>
                        <td><input type="checkbox" aria-label={`Sender can choose: ${label}`} checked={(d.senderChoices as Record<string, boolean>)[k] ?? true} onChange={(e) => set({ senderChoices: { ...d.senderChoices, [k]: e.target.checked } })} style={{ width: 17, height: 17, accentColor: 'var(--accent)' }} /></td>
                        <td><input type="checkbox" aria-label={`On unless changed: ${label}`} checked={(d.defaults as Record<string, boolean>)[k] ?? false} onChange={(e) => set({ defaults: { ...d.defaults, [k]: e.target.checked } })} style={{ width: 17, height: 17, accentColor: 'var(--accent)' }} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Group title="Reminders and problems">
              <DurationField id="n-lead" label="Warn that a transfer is about to expire" stored="hours" units={['hours', 'days']} value={d.expiringSoonLeadHours} min={1} max={168} onChange={(v) => set({ expiringSoonLeadHours: v })} hint="before it does." />
              <Check label="Also remind recipients who have not downloaded everything" checked={d.remindOutstandingRecipients} onChange={(v) => set({ remindOutstandingRecipients: v })} hint="They get a fresh link; their previous link stops working." />
              <Check label="Email the sender if a file fails its malware scan or upload" checked={d.scanFailureEmail} onChange={(v) => set({ scanFailureEmail: v })} />
              <ListField id="n-admins" label="Send operational alerts to" value={d.adminAlertEmails} onChange={(v) => set({ adminAlertEmails: v })} emptyMeans="Every active administrator is emailed." hint="For example a shared IT mailbox." />
            </Group>
          </>
        )}
      />
      <div className="card settings">
        <h2>See what the emails look like</h2>
        <div className="row">
          <label htmlFor="t-kind" className="visually-hidden">Email</label>
          <select id="t-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)} style={{ maxWidth: 320 }}>{Object.entries(TEMPLATE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <button className="btn" onClick={() => void get<{ subject: string; text: string; html: string }>(`/api/admin/templates/${kind}`).then(setPreview)}>Preview with sample details</button>
        </div>
        {preview && (
          <div style={{ marginTop: 14 }}>
            <p><span className="caps">Subject</span><br /><strong>{preview.subject}</strong></p>
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 480, border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: '#fff' }} />
            <details style={{ marginTop: 8 }}><summary className="small">Plain-text version</summary><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{preview.text}</pre></details>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------- storage
export function StorageSection() {
  return (
    <SectionForm
      section="storage"
      title="Storage and deletion"
      sensitive
      intro="Files live only on the encrypted content volume. Deletion is verified, retried if it fails, and checked again every hour and whenever the worker starts."
      render={(d, set) => (
        <>
          <Group title="Deleting" note="A server that is switched off cannot delete anything until it is back.">
            <DurationField id="st-target" label="Raise an alert if files are still there this long after expiry" stored="minutes" units={['minutes', 'hours']} value={d.deletionTargetMinutes} min={1} max={1440} onChange={(v) => set({ deletionTargetMinutes: v })} />
            <DurationField id="st-aband" label="Give up on an upload that has been idle for" stored="hours" units={['hours', 'days']} value={d.abandonedUploadHours} onChange={(v) => set({ abandonedUploadHours: v })} hint="The partial file is deleted and the space released." />
            <DurationField id="st-draft" label="Discard transfers that were never sent after" stored="days" units={['days']} value={d.draftTransferDays} onChange={(v) => set({ draftTransferDays: v })} />
          </Group>
          <Group title="Running out of space">
            <NumField id="st-warn" label="Warn administrators when free space falls below" value={d.lowDiskWarnPercent} min={1} max={99} onChange={(v) => set({ lowDiskWarnPercent: v })} suffix="% free" />
            <NumField id="st-crit" label="Refuse new uploads that would leave less than" value={d.lowDiskCriticalPercent} min={1} max={99} onChange={(v) => set({ lowDiskCriticalPercent: v })} suffix="% free" />
          </Group>
        </>
      )}
    />
  );
}

// ---------------------------------------------------------------------------------------- audit
export function AuditSection() {
  return (
    <SectionForm
      section="audit"
      title="Audit and privacy"
      sensitive
      intro="How long the record of what happened is kept after the files themselves are gone. File expiry is set separately, under What can be sent."
      impact={<>Shortening a period removes older records at the next daily run and cannot be undone. These settings do not make you compliant on their own: record your lawful basis, your retention decisions and what you tell recipients.</>}
      render={(d, set) => (
        <>
          <Group title="After a transfer's files are deleted" note="First the names and addresses are removed; later the anonymous record goes too.">
            <DurationField id="a-meta" label="Keep file names, recipient addresses, subject and note for" stored="days" units={['days']} value={d.metadataRetentionDays} min={1} max={3650} onChange={(v) => set({ metadataRetentionDays: v })} />
            <DurationField id="a-ret" label="Keep the activity log for" stored="days" units={['days']} value={d.auditRetentionDays} min={30} max={3650} onChange={(v) => set({ auditRetentionDays: v })} hint="Log entries keep the email address recorded at the time until this period ends." />
          </Group>
          <Group title="Who sees what">
            <Check label="Auditors can see recipients' email addresses" checked={d.auditorsSeeRecipientEmails} onChange={(v) => set({ auditorsSeeRecipientEmails: v })} hint='When off, auditors see "[recipient]" instead and cannot search by recipient.' />
          </Group>
        </>
      )}
    />
  );
}
