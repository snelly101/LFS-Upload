import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { formatBytes, type RecipientAuthorisedView } from '@securesend/shared';
import { get, post, errorMessage, ApiError } from '../api';
import { fmtLong, countdown } from '../lib/time';

interface PublicView {
  state: 'needs_verification' | 'bearer_ready' | 'expired' | 'revoked' | 'unavailable' | 'not_found';
  hasSession: boolean;
  productName: string;
  organisationName: string;
  supportEmail: string | null;
  accentColour: string;
  logoDataUrl: string | null;
  recipientHint: string | null;
  verification: { codeTtlSeconds: number; resendCooldownSeconds: number } | null;
}

/**
 * External recipient page. Minimal layout, no admin shell, no third-party scripts.
 * The initial GET is side-effect free (apart from "link first fetched"); codes are only sent on explicit request.
 */
export function RecipientPage() {
  const { token = '' } = useParams();
  const base = `/api/r/${encodeURIComponent(token)}`;
  const [pub, setPub] = useState<PublicView | null>(null);
  const [view, setView] = useState<RecipientAuthorisedView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const live = useRef<HTMLDivElement>(null);

  useEffect(() => {
    get<PublicView>(base)
      .then(async (p) => {
        setPub(p);
        document.title = p.productName;
        document.documentElement.style.setProperty('--accent', p.accentColour);
        if (p.hasSession) {
          try {
            setView(await get<RecipientAuthorisedView>(`${base}/view`));
          } catch {
            /* session lapsed; show verification */
          }
        }
      })
      .catch((e) => setLoadErr(errorMessage(e)));
  }, [base]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const requestCode = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ cooldownSeconds: number }>(`${base}/code`, {});
      setCodeSent(true);
      setCooldown(r.cooldownSeconds);
      live.current && (live.current.textContent = 'A code has been emailed to you.');
    } catch (e) {
      if (e instanceof ApiError && typeof e.body.retryAfterSeconds === 'number') setCooldown(e.body.retryAfterSeconds);
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ view: RecipientAuthorisedView }>(`${base}/verify`, { code });
      setView(r.view);
    } catch (x) {
      setErr(errorMessage(x));
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ view: RecipientAuthorisedView }>(`${base}/open`, {});
      setView(r.view);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await post(`${base}/signout`, {}).catch(() => undefined);
    setView(null);
    setCodeSent(false);
  };

  const frame = (children: React.ReactNode) => (
    <div className="rcpt">
      <header className="rcpt-head">
        {pub?.logoDataUrl ? <img src={pub.logoDataUrl} alt="" /> : <span className="mark" aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--accent)' }} />}
        <span>{pub?.productName ?? 'Secure transfer'}</span>
      </header>
      <main className="rcpt-card" id="main">{children}</main>
      <p className="rcpt-foot">
        {pub?.organisationName}
        {pub?.supportEmail ? <> · Questions? Contact <a href={`mailto:${pub.supportEmail}`}>{pub.supportEmail}</a></> : null}
        <br />
        Files are transferred over an encrypted connection and deleted after the expiry date. Email verification confirms control of the addressed mailbox at this moment; it is not proof of identity.
      </p>
      <div ref={live} className="visually-hidden" aria-live="polite" />
    </div>
  );

  if (loadErr) return frame(<><h1>This link cannot be opened</h1><p>{loadErr}</p></>);
  if (!pub) return frame(<p>Loading…</p>);

  if (view) {
    const expired = new Date(view.expiresAt).getTime() <= now;
    return frame(
      <>
        <p className="small muted">From</p>
        <h1 style={{ marginBottom: 2 }}>{view.senderName}</h1>
        <p className="small muted">{view.senderEmail}{view.recipientEmail ? <> · to {view.recipientEmail}</> : <> · opened with a bearer link (recipient not verified)</>}</p>
        {view.title && <h2 style={{ marginTop: 14 }}>{view.title}</h2>}
        {view.message && <p style={{ whiteSpace: 'pre-wrap' }}>{view.message}</p>}
        {expired && <div className="notice notice-warn" role="alert">This transfer has now expired. Downloads are no longer possible.</div>}
        <ul className="rcpt-files" aria-label="Files">
          {view.files.map((f) => (
            <li key={f.id}>
              <span style={{ overflowWrap: 'anywhere' }}>{f.name}<div className="small muted">{formatBytes(f.sizeBytes)}</div></span>
              <a className="btn btn-sm" href={`${base}/files/${f.id}`} download={f.name} aria-label={`Download ${f.name}`} onClick={() => void post(`${base}/files/${f.id}/ack`, {}).catch(() => undefined)}>Download</a>
            </li>
          ))}
        </ul>
        <div className="row-between">
          <div>
            {view.allowZip && <a className="btn btn-primary btn-lg" href={`${base}/zip`} aria-describedby="zip-note">Download all ({formatBytes(view.totalBytes)})</a>}
            {!view.allowZip && view.files[0] && <a className="btn btn-primary btn-lg" href={`${base}/files/${view.files[0].id}`} download={view.files[0].name} onClick={() => void post(`${base}/files/${view.files[0]!.id}/ack`, {}).catch(() => undefined)}>Download ({formatBytes(view.totalBytes)})</a>}
          </div>
          <div className="small muted" style={{ textAlign: 'right' }}>
            Available until<br /><strong>{fmtLong(view.expiresAt)}</strong><br />({countdown(view.expiresAt)})
          </div>
        </div>
        <p id="zip-note" className="hint" style={{ marginTop: 12 }}>
          {view.allowZip ? 'The "Download all" ZIP is built as it streams, so it cannot be resumed if the connection drops. Individual files can be resumed by your browser.' : 'Your browser can resume this download if the connection drops.'}
          {view.downloadsRemaining !== null && <> Downloads remaining per file: {view.downloadsRemaining}.</>}
          {' '}Your access session ends at {fmtLong(view.sessionExpiresAt)}; after that you will need a new code.
        </p>
        <p className="small"><button className="btn-link" onClick={() => void signOut()}>Finish and sign out</button></p>
      </>,
    );
  }

  switch (pub.state) {
    case 'not_found':
      return frame(<><h1>This link is not valid</h1><p>Check that you copied the whole link from the email. If you received a newer email for the same transfer, use the link in that one.</p></>);
    case 'expired':
      return frame(<><h1>This transfer has expired</h1><p>The files are no longer available and have been scheduled for deletion. If you still need them, please ask the sender to send a new transfer.</p></>);
    case 'revoked':
      return frame(<><h1>Access has been withdrawn</h1><p>The sender has withdrawn access to this transfer. If you think this is a mistake, please contact the sender.</p></>);
    case 'unavailable':
      return frame(<><h1>This transfer is not available</h1><p>The files cannot be downloaded at the moment. Please contact the sender.</p></>);
    case 'bearer_ready':
      return frame(
        <>
          <h1>You have been sent files</h1>
          <p>This link does not require verification. Anyone who holds it can download the files, so please do not forward it.</p>
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          <button className="btn btn-primary btn-lg" onClick={() => void open()} disabled={busy}>Open transfer</button>
        </>,
      );
    case 'needs_verification':
      return frame(
        <>
          <h1>You have been sent files</h1>
          <p>To protect them, we will email a one-time code to <strong>{pub.recipientHint}</strong>. Only someone who can read that mailbox can open the transfer.</p>
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          {!codeSent ? (
            <button className="btn btn-primary btn-lg" onClick={() => void requestCode()} disabled={busy || cooldown > 0}>
              {cooldown > 0 ? `Email me a code (wait ${cooldown}s)` : 'Email me a code'}
            </button>
          ) : (
            <form onSubmit={verify}>
              <div className="notice notice-ok" role="status">Code sent. It expires in {Math.round((pub.verification?.codeTtlSeconds ?? 600) / 60)} minutes.</div>
              <div className="field">
                <label htmlFor="code">Enter the 6-digit code</label>
                <input id="code" className="input code-input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6,8}" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus required />
              </div>
              <button className="btn btn-primary btn-lg" disabled={busy || code.length < 6}>Open transfer</button>
              <p className="small" style={{ marginTop: 12 }}>
                Didn't get it? Check your junk folder, or{' '}
                <button type="button" className="btn-link" onClick={() => void requestCode()} disabled={busy || cooldown > 0}>{cooldown > 0 ? `send a new code in ${cooldown}s` : 'send a new code'}</button>. A new code replaces the previous one.
              </p>
            </form>
          )}
        </>,
      );
  }
}
