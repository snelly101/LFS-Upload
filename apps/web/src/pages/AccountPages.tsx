import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { get, post, errorMessage } from '../api';
import { AuthFrame } from './Login';
import { useAuth } from '../auth/AuthContext';

export function InvitePage() {
  const { token } = useParams();
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [info, setInfo] = useState<{ email: string; displayName: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<{ email: string; displayName: string }>(`/api/auth/invite/${token}`)
      .then((i) => {
        setInfo(i);
        setDisplayName(i.displayName);
      })
      .catch((e) => setErr(errorMessage(e)));
  }, [token]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== password2) return setErr('Passwords do not match.');
    setBusy(true);
    post('/api/auth/invite/accept', { token, password, displayName })
      .then(async () => {
        await refresh();
        nav('/login', { replace: true });
      })
      .catch((x) => setErr(errorMessage(x)))
      .finally(() => setBusy(false));
  };
  return (
    <AuthFrame title="Set up your account">
      {err && <div className="notice notice-err" role="alert">{err}</div>}
      {info && (
        <form onSubmit={submit}>
          <p className="small muted">Account: {info.email}</p>
          <div className="field">
            <label htmlFor="dn">Display name</label>
            <input id="dn" className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pw">Password</label>
            <input id="pw" className="input" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
            <span className="hint">At least 12 characters. A passphrase of several words works well.</span>
          </div>
          <div className="field">
            <label htmlFor="pw2">Confirm password</label>
            <input id="pw2" className="input" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required />
          </div>
          <button className="btn btn-primary" disabled={busy}>Continue to second-factor setup</button>
        </form>
      )}
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    post<{ message: string }>('/api/auth/password/forgot', { email })
      .then((r) => setMsg(r.message))
      .catch((x) => setErr(errorMessage(x)));
  };
  return (
    <AuthFrame title="Reset your password">
      {msg ? (
        <p>{msg}</p>
      ) : (
        <form onSubmit={submit}>
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <button className="btn btn-primary">Send reset link</button>
        </form>
      )}
      <p className="small" style={{ marginTop: 12 }}>
        <Link to="/login">Back to sign in</Link>
      </p>
      <p className="small muted">Resetting your password does not remove your second factor; you will still need it to sign in.</p>
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    post('/api/auth/password/reset', { token, password })
      .then(() => setDone(true))
      .catch((x) => setErr(errorMessage(x)));
  };
  return (
    <AuthFrame title="Choose a new password">
      {done ? (
        <p>
          Your password has been changed and other sessions signed out. <Link to="/login">Sign in</Link> with your new password and second factor.
        </p>
      ) : (
        <form onSubmit={submit}>
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          <div className="field">
            <label htmlFor="pw">New password</label>
            <input id="pw" className="input" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button className="btn btn-primary">Change password</button>
        </form>
      )}
    </AuthFrame>
  );
}
