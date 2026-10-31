import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import { get, post, del, errorMessage } from '../api';
import { useAuth } from '../auth/AuthContext';
import { fmt } from '../lib/time';
import { Dialog } from '../components/Dialog';

interface SessionItem {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  ipPrefix: string | null;
  userAgent: string | null;
  authMethod: string;
  mfaMethod: string | null;
}

export function SecurityPage() {
  const { me, refresh, withStepUp } = useAuth();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ sessions: SessionItem[] }>('/api/auth/sessions') });
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [totp, setTotp] = useState<{ otpauthUrl: string; secretBase32: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [label, setLabel] = useState('');
  const run = (fn: () => Promise<void>, okText?: string) =>
    withStepUp(fn)
      .then(async () => {
        if (okText) setMsg({ tone: 'ok', text: okText });
        await refresh();
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      })
      .catch((e) => setMsg({ tone: 'err', text: errorMessage(e) }));
  const mfa = me?.mfa;
  const user = me?.user;
  if (!user) return null;
  const addPasskey = () =>
    run(async () => {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/api/auth/enrol/passkey/options');
      const response = await startRegistration({ optionsJSON });
      const r = await post<{ recoveryCodes: string[] | null }>('/api/auth/enrol/passkey/verify', { response, label: label || 'Passkey' });
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
      setLabel('');
    }, 'Passkey added.');
  const beginTotp = () => run(async () => setTotp(await post('/api/auth/enrol/totp/begin')));
  const confirmTotp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ recoveryCodes: string[] | null }>('/api/auth/enrol/totp/confirm', { code: totpCode });
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
      setTotp(null);
      setTotpCode('');
    }, 'Authenticator app added.');
  };
  const changePw = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await post('/api/auth/password/change', { currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: '', next: '' });
    }, 'Password changed. Other sessions were signed out.');
  };
  return (
    <>
      <div className="page-head"><div><h1>Account security</h1><p>{user.email} · {user.authKind === 'sso' ? 'Single sign-on account' : 'Local account'}</p></div></div>
      {msg && <div className={`notice notice-${msg.tone}`} role={msg.tone === 'err' ? 'alert' : 'status'}>{msg.text}</div>}
      <div className="two-col">
        <div>
          {user.authKind === 'local' && (
            <section className="card" aria-labelledby="f-h">
              <h2 id="f-h">Second factors</h2>
              <p className="small muted">At least one factor must remain. Changes need a recent re-authentication and trigger a security notice by email.</p>
              <h3>Passkeys</h3>
              {mfa?.passkeys.length ? (
                <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                  {mfa.passkeys.map((p) => (
                    <li key={p.id} className="row-between">
                      <span>{p.label} <span className="small muted">added {fmt(p.createdAt)}{p.lastUsedAt ? `, last used ${fmt(p.lastUsedAt)}` : ''}</span></span>
                      <button className="btn btn-sm btn-danger" onClick={() => void run(() => del(`/api/auth/passkeys/${p.id}`).then(() => undefined), 'Passkey removed.')}>Remove</button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No passkeys.</p>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                <label htmlFor="pk-label" className="visually-hidden">Passkey label</label>
                <input id="pk-label" className="input" style={{ width: 200 }} placeholder="Label (e.g. Work laptop)" value={label} onChange={(e) => setLabel(e.target.value)} />
                <button className="btn" onClick={() => void addPasskey()}>Add passkey</button>
              </div>
              <hr className="divider" />
              <h3>Authenticator app</h3>
              {mfa?.totp ? (
                <div className="row-between"><span>Enabled</span><button className="btn btn-sm btn-danger" onClick={() => void run(() => del('/api/auth/totp').then(() => undefined), 'Authenticator app removed.')}>Remove</button></div>
              ) : totp ? (
                <form onSubmit={confirmTotp}>
                  <p className="small">Add the key to your app, then enter the code.</p>
                  <p><a href={totp.otpauthUrl} className="small">Add to authenticator app</a></p>
                  <p className="mono" style={{ overflowWrap: 'anywhere' }}>{totp.secretBase32.match(/.{1,4}/g)?.join(' ')}</p>
                  <div className="field"><label htmlFor="tc">6-digit code</label><input id="tc" className="input code-input" inputMode="numeric" maxLength={6} value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))} /></div>
                  <button className="btn btn-primary" disabled={totpCode.length !== 6}>Confirm</button>
                </form>
              ) : (
                <button className="btn" onClick={() => void beginTotp()}>Set up authenticator app</button>
              )}
              <hr className="divider" />
              <h3>Recovery codes</h3>
              <p className="small">{mfa?.recoveryCodesRemaining ?? 0} unused codes remaining.</p>
              <button className="btn" onClick={() => void run(async () => setCodes((await post<{ recoveryCodes: string[] }>('/api/auth/recovery-codes/regenerate')).recoveryCodes), 'Recovery codes regenerated; old codes no longer work.')}>Regenerate recovery codes</button>
            </section>
          )}
          {user.authKind === 'local' && (
            <section className="card" aria-labelledby="pw-h">
              <h2 id="pw-h">Change password</h2>
              <form onSubmit={changePw}>
                <div className="field"><label htmlFor="cur">Current password</label><input id="cur" className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></div>
                <div className="field"><label htmlFor="nxt">New password</label><input id="nxt" className="input" type="password" autoComplete="new-password" minLength={12} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required /></div>
                <button className="btn btn-primary">Change password</button>
              </form>
            </section>
          )}
          {user.authKind === 'sso' && <section className="card"><h2>Sign-in</h2><p>Your account is managed by your identity provider, including multi-factor authentication and password. Disabling the account there stops new sign-ins; existing sessions end at their idle or absolute limit, or when an administrator revokes them.</p></section>}
        </div>
        <aside className="card" aria-labelledby="s-h">
          <div className="card-head"><h2 id="s-h">Sessions</h2><button className="btn btn-sm" onClick={() => void run(() => post('/api/auth/sessions/revoke-others').then(() => undefined), 'Other sessions signed out.')}>Sign out other sessions</button></div>
          <ul className="receipt">
            {sessions.data?.sessions.map((s) => (
              <li key={s.id}>
                <time dateTime={s.lastSeenAt}>{fmt(s.lastSeenAt)}</time>
                <div>
                  {s.current ? <strong>This session</strong> : 'Session'} · {s.authMethod}{s.mfaMethod ? ` + ${s.mfaMethod}` : ''}
                  <div className="who">{s.ipPrefix ?? 'unknown network'} · {(s.userAgent ?? '').slice(0, 60)}</div>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      </div>
      <Dialog title="Your recovery codes" open={!!codes} onClose={() => setCodes(null)} footer={<button className="btn btn-primary" onClick={() => setCodes(null)}>I have saved them</button>}>
        <p>Each code can be used once in place of your second factor. They will not be shown again.</p>
        <div className="codes">{codes?.map((c) => <div key={c}>{c}</div>)}</div>
      </Dialog>
    </>
  );
}
