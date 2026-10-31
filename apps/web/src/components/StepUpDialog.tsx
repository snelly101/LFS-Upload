import { useState, type FormEvent } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { Dialog } from './Dialog';
import { post, errorMessage } from '../api';
import type { MfaStatus } from '../lib/types';

export function StepUpDialog({ mfa, onDone }: { mfa: MfaStatus | undefined; onDone: (ok: boolean) => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitTotp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post('/api/auth/step-up/totp', { code });
      onDone(true);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const passkey = async () => {
    setBusy(true);
    setErr(null);
    try {
      const optionsJSON = await post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/api/auth/step-up/passkey/options');
      const response = await startAuthentication({ optionsJSON });
      await post('/api/auth/step-up/passkey/verify', { response });
      onDone(true);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Confirm it's you" open onClose={() => onDone(false)}>
      <p className="small muted">This action is security-sensitive and needs a recent second-factor check.</p>
      {err && <div className="notice notice-err" role="alert">{err}</div>}
      {mfa?.totp && (
        <form onSubmit={submitTotp}>
          <div className="field">
            <label htmlFor="su-code">Authenticator code</label>
            <input id="su-code" className="input code-input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </div>
          <button className="btn btn-primary" disabled={busy || code.length !== 6}>Confirm</button>
        </form>
      )}
      {mfa?.passkeys.length ? (
        <p style={{ marginTop: 12 }}>
          <button className="btn" onClick={passkey} disabled={busy}>Use a passkey</button>
        </p>
      ) : null}
      <p style={{ marginTop: 12 }}>
        <button className="btn-link" onClick={() => onDone(false)}>Cancel</button>
      </p>
    </Dialog>
  );
}
