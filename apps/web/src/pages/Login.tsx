import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useAuth } from '../auth/AuthContext';
import { post, errorMessage } from '../api';

type Stage = 'password' | 'mfa' | 'enrol' | 'enrol-totp' | 'enrol-passkey' | 'recovery-codes';

const SSO_ERRORS: Record<string, string> = {
  sso_state: 'The sign-in attempt expired. Please try again.',
  sso_not_allowed: 'Your account is not in the allowed users or groups for this application. Ask an administrator.',
  sso_tenant_mismatch: 'Sign-in came from a tenant that is not trusted by this application.',
  sso_issuer_mismatch: 'The identity provider did not match the configured issuer.',
  sso_audience_mismatch: 'The token was not issued for this application.',
  sso_email_clash: 'An account with this email already exists and cannot be linked automatically. Ask an administrator.',
  sso_mfa_not_reported: 'The identity provider did not report multi-factor authentication. Check your Conditional Access policy.',
  sso_disabled: 'This account is disabled.',
};

export function AuthFrame({ children, title }: { children: React.ReactNode; title?: string }) {
  const { options } = useAuth();
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          {options?.logoDataUrl ? <img src={options.logoDataUrl} alt="" /> : <span className="mark" aria-hidden="true" />}
          <span>{options?.productName ?? 'Snelson Send'}</span>
        </div>
        {title && <h1>{title}</h1>}
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { options, me, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') && params.get('next')!.startsWith('/') ? params.get('next')! : '/transfers';
  const [stage, setStage] = useState<Stage>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [methods, setMethods] = useState({ totp: false, passkey: false, recovery: false });
  const [mfaMode, setMfaMode] = useState<'totp' | 'recovery'>('totp');
  const [err, setErr] = useState<string | null>(params.get('error') ? SSO_ERRORS[params.get('error')!] ?? 'Single sign-on failed.' : null);
  const [busy, setBusy] = useState(false);
  const [totpSetup, setTotpSetup] = useState<{ otpauthUrl: string; secretBase32: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  useEffect(() => {
    if (me?.user && me.user.authLevel === 'full' && stage === 'password') nav(next, { replace: true });
    if (me?.user && me.user.authLevel === 'password_only' && stage === 'password') {
      setStage(me.mfa?.enrolled ? 'mfa' : 'enrol');
      if (me.mfa) setMethods({ totp: me.mfa.totp, passkey: me.mfa.passkeys.length > 0, recovery: me.mfa.recoveryCodesRemaining > 0 });
    }
  }, [me, stage, nav, next]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const login = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ next: 'mfa' | 'enrol_mfa'; methods: typeof methods }>('/api/auth/login', { email, password });
      setMethods(r.methods);
      setMfaMode(r.methods.totp ? 'totp' : 'recovery');
      setStage(r.next === 'mfa' ? 'mfa' : 'enrol');
      setPassword('');
    });
  };
  const finish = async () => {
    await refresh();
    nav(next, { replace: true });
  };
  const verifyTotp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (mfaMode === 'totp') await post('/api/auth/mfa/totp/verify', { code });
      else await post('/api/auth/mfa/recovery', { code });
      await finish();
    });
  };
  const passkeyLogin = () =>
    void run(async () => {
      const optionsJSON = await post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/api/auth/mfa/passkey/options');
      const response = await startAuthentication({ optionsJSON });
      await post('/api/auth/mfa/passkey/verify', { response });
      await finish();
    });
  const beginTotp = () =>
    void run(async () => {
      setTotpSetup(await post('/api/auth/enrol/totp/begin'));
      setStage('enrol-totp');
    });
  const confirmTotp = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ recoveryCodes: string[] | null }>('/api/auth/enrol/totp/confirm', { code });
      setRecoveryCodes(r.recoveryCodes);
      setStage('recovery-codes');
    });
  };
  const enrolPasskey = () =>
    void run(async () => {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]['optionsJSON']>('/api/auth/enrol/passkey/options');
      const response = await startRegistration({ optionsJSON });
      const r = await post<{ recoveryCodes: string[] | null }>('/api/auth/enrol/passkey/verify', { response, label: 'Passkey' });
      setRecoveryCodes(r.recoveryCodes);
      setStage('recovery-codes');
    });

  if (stage === 'mfa') {
    return (
      <AuthFrame title="Second factor">
        {err && <div className="notice notice-err" role="alert">{err}</div>}
        {methods.passkey && (
          <p>
            <button className="btn btn-primary" onClick={passkeyLogin} disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>Use passkey</button>
          </p>
        )}
        {(methods.totp || methods.recovery) && (
          <form onSubmit={verifyTotp}>
            <div className="field">
              <label htmlFor="mfa-code">{mfaMode === 'totp' ? 'Authenticator app code' : 'Recovery code'}</label>
              {mfaMode === 'totp' ? (
                <input id="mfa-code" className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus required />
              ) : (
                <input id="mfa-code" className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="xxxx-xxxx-xxxx" autoFocus required />
              )}
            </div>
            <button className="btn btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>Continue</button>
          </form>
        )}
        <p className="small" style={{ marginTop: 14 }}>
          {methods.totp && mfaMode === 'recovery' && <button className="btn-link" onClick={() => { setMfaMode('totp'); setCode(''); }}>Use authenticator app instead</button>}
          {methods.recovery && mfaMode === 'totp' && <button className="btn-link" onClick={() => { setMfaMode('recovery'); setCode(''); }}>Use a recovery code instead</button>}
        </p>
        <p className="small muted">Lost all your factors? Ask an administrator to reset your second factor; you will receive a security notice.</p>
      </AuthFrame>
    );
  }
  if (stage === 'enrol') {
    return (
      <AuthFrame title="Set up a second factor">
        <p>Multi-factor authentication is required before you can send files. Choose a method:</p>
        {err && <div className="notice notice-err" role="alert">{err}</div>}
        <div className="stack">
          <button className="btn btn-primary" onClick={enrolPasskey} disabled={busy}>Create a passkey (recommended)</button>
          <button className="btn" onClick={beginTotp} disabled={busy}>Use an authenticator app</button>
        </div>
        <p className="small muted" style={{ marginTop: 14 }}>Passkeys use your device's screen lock or security key. Authenticator apps generate 6-digit codes.</p>
      </AuthFrame>
    );
  }
  if (stage === 'enrol-totp' && totpSetup) {
    return (
      <AuthFrame title="Authenticator app">
        <p>Add this account to your authenticator app, then enter the code it shows.</p>
        <p className="small">Open this link on the device with the app, or enter the key manually:</p>
        <p>
          <a href={totpSetup.otpauthUrl} className="small" style={{ overflowWrap: 'anywhere' }}>Add to authenticator app</a>
        </p>
        <p className="mono" style={{ overflowWrap: 'anywhere', background: 'var(--surface-muted)', padding: 8, borderRadius: 4 }}>{totpSetup.secretBase32.match(/.{1,4}/g)?.join(' ')}</p>
        {err && <div className="notice notice-err" role="alert">{err}</div>}
        <form onSubmit={confirmTotp}>
          <div className="field">
            <label htmlFor="enrol-code">6-digit code</label>
            <input id="enrol-code" className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
          </div>
          <button className="btn btn-primary" disabled={busy || code.length !== 6}>Confirm</button>{' '}
          <button type="button" className="btn" onClick={() => setStage('enrol')}>Back</button>
        </form>
      </AuthFrame>
    );
  }
  if (stage === 'recovery-codes') {
    return (
      <AuthFrame title="Second factor enabled">
        {recoveryCodes ? (
          <>
            <p>Save these recovery codes somewhere safe. Each can be used once if you lose your device. They will not be shown again.</p>
            <div className="codes" aria-label="Recovery codes">
              {recoveryCodes.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
          </>
        ) : (
          <p>Your new factor has been added.</p>
        )}
        <p style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={() => void finish()}>Continue</button>
        </p>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Sign in">
      {err && <div className="notice notice-err" role="alert">{err}</div>}
      {options?.ssoEnabled && (
        <p>
          <a className="btn btn-primary" href="/api/auth/sso/start" style={{ width: '100%', justifyContent: 'center' }}>Sign in with {options.ssoLabel}</a>
        </p>
      )}
      {options?.localLoginEnabled && (
        <form onSubmit={login}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>Continue</button>
          <p className="small" style={{ marginTop: 12 }}>
            <Link to="/forgot-password">Forgotten your password?</Link>
          </p>
        </form>
      )}
      {options && !options.ssoEnabled && !options.localLoginEnabled && <p>No sign-in method is enabled. Contact your administrator.</p>}
    </AuthFrame>
  );
}
