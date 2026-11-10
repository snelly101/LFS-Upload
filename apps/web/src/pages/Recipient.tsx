import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { formatBytes, type RecipientAuthorisedView } from '@securesend/shared';
import { get, post, errorMessage, ApiError } from '../api';
import { fmtLong, countdown } from '../lib/time';
import { applyBrand } from '../lib/theme';
import { Brand } from '../components/Brand';

interface PublicView {
  state: 'needs_verification' | 'bearer_ready' | 'expired' | 'revoked' | 'unavailable' | 'not_found';
  hasSession: boolean;
  productName: string;
  organisationName: string;
  supportEmail: string | null;
  accentColour: string;
  logoDataUrl: string | null;
  theme?: 'civic' | 'clear';
  colourScheme?: 'auto' | 'light' | 'dark';
  recipientHint: string | null;
  verification: { codeTtlSeconds: number; resendCooldownSeconds: number } | null;
}

function tokenFromPath(): string {
  const m = /^\/r\/([^/]+)/.exec(window.location.pathname);
  return m ? decodeURIComponent(m[1]!) : '';
}

/**
 * External recipient page. Its own small bundle: no staff shell, no router, no third-party scripts.
 * The initial GET is side-effect free (apart from "link first fetched"); a code is only ever sent
 * when the person presses the button, and nothing about the transfer is shown before verification.
 */
export default function RecipientPage() {
  const token = tokenFromPath();
  const base = `/api/r/${encodeURIComponent(token)}`;
  const [pub, setPub] = useState<PublicView | null>(null);
  const [view, setView] = useState<RecipientAuthorisedView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const live = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return; // exactly one GET per page load, even under React strict mode
    loaded.current = true;
    get<PublicView>(base)
      .then(async (p) => {
        setPub(p);
        document.title = p.productName;
        applyBrand({ theme: p.theme, colourScheme: p.colourScheme, accentColour: p.accentColour });
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
  // When the access session runs out, drop back to verification rather than leaving dead buttons.
  useEffect(() => {
    if (!view) return;
    if (new Date(view.sessionExpiresAt).getTime() <= now && new Date(view.expiresAt).getTime() > now) {
      setView(null);
      setCodeSent(false);
      setCode('');
      setSessionEnded(true);
    }
  }, [view, now]);

  const say = (msg: string) => {
    if (live.current) live.current.textContent = msg;
  };
  const requestCode = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<{ cooldownSeconds: number }>(`${base}/code`, {});
      setCodeSent(true);
      setCooldown(r.cooldownSeconds);
      say('A code has been emailed to you.');
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
      setSessionEnded(false);
      setView(r.view);
      say('Verified. Your files are ready.');
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
      setSessionEnded(false);
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
    setCode('');
  };
  const ack = (fileId: string) => void post(`${base}/files/${fileId}/ack`, {}).catch(() => undefined);

  const frame = (children: ReactNode, kicker?: string) => (
    <div className="rcpt">
      <header className="rcpt-head brand">
        <Brand productName={pub?.productName ?? 'Secure file delivery'} organisationName={pub?.organisationName ?? ''} logoDataUrl={pub?.logoDataUrl} large />
      </header>
      <main className="rcpt-card" id="main">
        {kicker && <p className="caps" style={{ marginBottom: 8 }}>{kicker}</p>}
        {children}
      </main>
      <p className="rcpt-foot">
        {pub?.organisationName && <strong>{pub.organisationName}</strong>}
        {pub?.supportEmail ? <> · Questions? <a href={`mailto:${pub.supportEmail}`}>{pub.supportEmail}</a></> : null}
        {pub && <br />}
        Sent over an encrypted connection and deleted after the expiry date. Verifying by email confirms control of the mailbox at this moment; it is not proof of identity.
      </p>
      <div ref={live} className="visually-hidden" aria-live="polite" />
    </div>
  );

  if (loadErr) return frame(<><h1>This link cannot be opened</h1><p>{loadErr}</p><p className="muted">Please try again in a moment.</p></>);
  if (!pub) return frame(<p className="muted" role="status">Loading…</p>);

  if (view) {
    const expired = new Date(view.expiresAt).getTime() <= now;
    const single = view.files.length === 1 ? view.files[0]! : null;
    return frame(
      <>
        <div className="rcpt-from">
          <div className="name">{view.senderName}</div>
          <div className="small muted" style={{ overflowWrap: 'anywhere' }}>
            {view.senderEmail}
            {view.recipientEmail ? <> · for {view.recipientEmail}</> : <> · opened with a link that needs no verification</>}
          </div>
        </div>
        {view.title && <h1 style={{ fontSize: '1.3rem' }}>{view.title}</h1>}
        {view.message && <p className="rcpt-note">{view.message}</p>}
        {expired && <div className="notice notice-warn" role="alert"><strong>This delivery has now expired</strong>Downloads are no longer possible. Ask the sender if you still need the files.</div>}
        <ul className="rcpt-files" aria-label="Files">
          {view.files.map((f) => (
            <li key={f.id}>
              <span>
                <span className="fname">{f.name}</span>
                <div className="small muted num">{formatBytes(f.sizeBytes)}</div>
              </span>
              {!single && !expired && (
                <a className="btn btn-sm" href={`${base}/files/${f.id}`} download={f.name} aria-label={`Download ${f.name}`} onClick={() => ack(f.id)}>Download</a>
              )}
            </li>
          ))}
        </ul>
        {!expired && (
          <div className="rcpt-cta">
            {single ? (
              <a className="btn btn-primary btn-lg" href={`${base}/files/${single.id}`} download={single.name} aria-label={`Download ${single.name}`} onClick={() => ack(single.id)}>Download · {formatBytes(view.totalBytes)}</a>
            ) : (
              <a className="btn btn-primary btn-lg" href={`${base}/zip`} aria-describedby="dl-note">Download all · {formatBytes(view.totalBytes)}</a>
            )}
            <div className="rcpt-until">
              Available until
              <strong>{fmtLong(view.expiresAt)}</strong>
              {countdown(view.expiresAt)}
            </div>
          </div>
        )}
        <p id="dl-note" className="hint" style={{ marginTop: 16 }}>
          {single
            ? 'If your connection drops, your browser can pick the download up where it left off.'
            : '"Download all" arrives as one ZIP that is built as it downloads, so it starts again from the beginning if the connection drops. Single files can be resumed by your browser.'}
          {view.downloadsRemaining !== null && <> Downloads left per file: {view.downloadsRemaining}.</>}
        </p>
        <p className="small muted" style={{ marginBottom: 0 }}>
          This page stays open to you until {fmtLong(view.sessionExpiresAt)}; after that you will be asked for a new code.{' '}
          <button className="btn-link" onClick={() => void signOut()}>Finish and sign out</button>
        </p>
      </>,
      'Secure delivery from',
    );
  }

  switch (pub.state) {
    case 'not_found':
      return frame(<><h1>This link isn't recognised</h1><p>Check that the whole link was copied from the email. If you were sent a newer email about the same delivery, use the link in that one: older links stop working when a new one is issued.</p></>);
    case 'expired':
      return frame(<><h1>This delivery has expired</h1><p>The files are no longer available. If you still need them, please ask the person who sent them to send a new delivery.</p></>);
    case 'revoked':
      return frame(<><h1>This delivery was withdrawn</h1><p>The sender has withdrawn access. If you think that was a mistake, please contact them directly.</p></>);
    case 'unavailable':
      return frame(<><h1>This delivery isn't available</h1><p>The files can't be downloaded at the moment. Please contact the person who sent them.</p></>);
    case 'bearer_ready':
      return frame(
        <>
          <h1>You have been sent files</h1>
          <p>This link opens the delivery without a code. Anyone who has the link can download the files, so please don't forward it.</p>
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          <button className="btn btn-primary btn-lg" onClick={() => void open()} disabled={busy}>Open transfer</button>
        </>,
        'Secure delivery',
      );
    case 'needs_verification':
      return frame(
        <>
          <h1>{sessionEnded ? 'Please verify again' : 'You have been sent files'}</h1>
          {sessionEnded && <p className="muted">For your protection this page only stays open for a limited time.</p>}
          <p>
            To open them, we'll email a one-time code to <strong>{pub.recipientHint}</strong>. Only someone who can read that mailbox can open this delivery.
          </p>
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          {!codeSent ? (
            <button className="btn btn-primary btn-lg" onClick={() => void requestCode()} disabled={busy || cooldown > 0}>
              {cooldown > 0 ? `Email me a code (wait ${cooldown}s)` : 'Email me a code'}
            </button>
          ) : (
            <form onSubmit={verify}>
              <div className="notice notice-ok" role="status">
                <strong>Code sent</strong>It can take a minute to arrive and expires in {Math.round((pub.verification?.codeTtlSeconds ?? 600) / 60)} minutes.
              </div>
              <div className="field">
                <label htmlFor="code">Enter the code from the email</label>
                <input id="code" className="input code-input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6,8}" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus required />
              </div>
              <button className="btn btn-primary btn-lg" disabled={busy || code.length < 6}>Open transfer</button>
              <p className="small muted" style={{ marginTop: 14, marginBottom: 0 }}>
                Nothing yet? Check your junk folder, or{' '}
                <button type="button" className="btn-link" onClick={() => void requestCode()} disabled={busy || cooldown > 0}>{cooldown > 0 ? `send a new code in ${cooldown}s` : 'send a new code'}</button>. A new code replaces the old one.
              </p>
            </form>
          )}
        </>,
        'Secure delivery',
      );
  }
}
