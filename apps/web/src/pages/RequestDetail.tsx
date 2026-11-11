import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, type ActivityEvent, type GrantView, type TransferDetail, type TransferFileView } from '@securesend/shared';
import { get, post, errorMessage } from '../api';
import { transferState } from '../components/Status';
import { Dialog } from '../components/Dialog';
import { Receipt } from '../components/Receipt';
import { RequestSteps, requestHeadline } from '../components/Steps';
import { fmt, fmtLong, countdown, toLocalInput, fromLocalInput } from '../lib/time';
import { refCode } from '../lib/labels';
import { usePollInterval } from '../lib/live';

type DialogKind = null | 'close' | 'remove' | 'add' | 'extend' | 'delete';

/** What state a received file is in, in the requester's terms. */
function fileState(f: TransferFileView): { text: string; tone: '' | 'ok' | 'err' | 'warn'; downloadable: boolean } {
  if (f.storageState === 'deleted') return { text: 'Deleted', tone: '', downloadable: false };
  if (f.uploadStatus !== 'finalised') return { text: `Arriving… ${f.sizeBytes ? Math.round((f.uploadedBytes / f.sizeBytes) * 100) : 0}%`, tone: '', downloadable: false };
  if (f.scanStatus === 'pending' || f.scanStatus === 'scanning') return { text: 'Checking…', tone: '', downloadable: false };
  if (f.scanStatus === 'infected') return { text: 'Blocked by malware scan', tone: 'err', downloadable: false };
  if (f.scanStatus === 'clean') return { text: 'Scan passed', tone: 'ok', downloadable: f.storageState === 'released' };
  return { text: 'Could not be checked, so it was not delivered', tone: 'warn', downloadable: false };
}

/** The requester's view of a file request: who was asked, what has arrived, and the files themselves. */
export function RequestDetail({ d }: { d: TransferDetail }) {
  const qc = useQueryClient();
  const poll = usePollInterval(60_000);
  const act = useQuery({ queryKey: ['transfer-activity', d.id], queryFn: () => get<{ events: ActivityEvent[] }>(`/api/transfers/${d.id}/activity`), refetchInterval: poll });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [grant, setGrant] = useState<GrantView | null>(null);
  const [reason, setReason] = useState('');
  const [email, setEmail] = useState('');
  const [expiry, setExpiry] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['transfer', d.id] });
    void qc.invalidateQueries({ queryKey: ['transfer-activity', d.id] });
    void qc.invalidateQueries({ queryKey: ['transfers'] });
  };
  const m = useMutation({
    mutationFn: ({ url, body }: { url: string; body?: unknown }) => post(url, body),
    onSuccess: () => {
      setDialog(null);
      setReason('');
      setErr(null);
      refresh();
    },
    onError: (e) => setErr(errorMessage(e)),
  });

  const state = transferState(d);
  const isLive = d.status === 'active' && d.deletionStatus === 'none' && new Date(d.expiresAt).getTime() > Date.now();
  const closed = !!d.closedAt;
  const open = isLive && !closed;
  const files = d.files.filter((f) => f.uploadStatus !== 'abandoned');
  const inFlight = files.some((f) => f.uploadStatus !== 'finalised' || f.scanStatus === 'pending' || f.scanStatus === 'scanning');
  const fileNames = Object.fromEntries(d.files.map((f) => [f.id, f.displayName]));

  // Files arrive from outside: keep the page current while something is uploading or being checked.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => void qc.invalidateQueries({ queryKey: ['transfer', d.id] }), inFlight ? 3000 : 20_000);
    return () => clearInterval(id);
  }, [open, inFlight, qc, d.id]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dialog === 'close') m.mutate({ url: `/api/transfers/${d.id}/close`, body: { reason } });
    if (dialog === 'remove' && grant) m.mutate({ url: `/api/transfers/${d.id}/grants/${grant.id}/revoke`, body: { reason } });
    if (dialog === 'add') m.mutate({ url: `/api/transfers/${d.id}/recipients`, body: { email, reason } });
    if (dialog === 'extend') m.mutate({ url: `/api/transfers/${d.id}/extend`, body: { expiresAt: fromLocalInput(expiry), reason } });
    if (dialog === 'delete') m.mutate({ url: `/api/transfers/${d.id}/delete-now`, body: {} });
  };
  const nudge = (g: GrantView, kind: 'remind' | 'resend') =>
    post(`/api/transfers/${d.id}/grants/${g.id}/${kind}`, {})
      .then(() => {
        setFlash(kind === 'remind' ? `A reminder is on its way to ${g.email}.` : `A fresh link is on its way to ${g.email}. The old link no longer works.`);
        refresh();
      })
      .catch((e) => setFlash(errorMessage(e)));
  const closeMenus = () => document.querySelectorAll('details.menu-btn[open]').forEach((el) => el.removeAttribute('open'));
  const label = closed && isLive ? 'Closed' : isLive ? 'Open' : state.label;
  const tone = closed && isLive ? 'neutral' : state.tone;
  const receivedBytes = files.filter((f) => f.scanStatus === 'clean').reduce((n, f) => n + f.sizeBytes, 0);
  const receivedCount = files.filter((f) => f.uploadStatus === 'finalised' && f.scanStatus === 'clean').length;

  return (
    <>
      <p className="small" style={{ marginBottom: 14 }}><Link to="/sent">← Sent</Link></p>
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <span className="tag tag-in" style={{ marginBottom: 8 }}><span aria-hidden="true">↓</span> File request</span>
          <h1 className="lede">{requestHeadline(d)}</h1>
          <p className="lede-sub">
            <strong>{d.title || 'Untitled'}</strong> · {receivedCount ? `${receivedCount} file${receivedCount === 1 ? '' : 's'}, ${formatBytes(receivedBytes)}` : 'no files yet'} · asked {fmt(d.sentAt ?? d.createdAt)}
          </p>
        </div>
        <span className={`stamp stamp-${tone} lg`}>{label}</span>
      </div>
      <p className="facts">
        <span>
          {open ? <>Open until <strong>{fmtLong(d.expiresAt)}</strong> ({countdown(d.expiresAt)})</> : isLive ? <>Closed to new files {fmt(d.closedAt)} · kept until <strong>{fmtLong(d.expiresAt)}</strong></> : <>Closing date was {fmtLong(d.expiresAt)}</>}
        </span>
        <span>Email code always required</span>
        <span className="ref">REF {refCode(d.id)}</span>
      </p>
      <div className="actions">
        {open && <button className="btn" onClick={() => { setErr(null); setEmail(''); setDialog('add'); }}>Add someone</button>}
        {isLive && d.effectivePolicy.allowExpiryExtension !== false && <button className="btn" onClick={() => { setExpiry(toLocalInput(d.expiresAt)); setErr(null); setDialog('extend'); }}>Change closing date</button>}
        {open && <button className="btn" onClick={() => { setErr(null); setDialog('close'); }}>Close to new files</button>}
        {d.deletionStatus === 'none' && <button className="btn btn-danger" onClick={() => { setErr(null); setDialog('delete'); }}>Delete everything now</button>}
      </div>

      {flash && <div className="notice notice-info" role="status">{flash} <button className="btn-link" onClick={() => setFlash(null)}>Dismiss</button></div>}
      {d.deletionStatus === 'failed' && <div className="notice notice-err" role="alert"><strong>Deletion failed</strong>Access is blocked and administrators have been alerted. Attempts: {d.deletion.attempts}. {d.deletion.lastError}</div>}
      {(d.deletionStatus === 'pending' || d.deletionStatus === 'in_progress') && <div className="notice notice-warn" role="status"><strong>Deleting files</strong>Requested {fmt(d.deletion.requestedAt)}. Nothing can be uploaded or downloaded any more.</div>}
      {d.deletionStatus === 'deleted' && <div className="notice notice-info" role="status"><strong>Files deleted</strong>Every copy was removed and verified at {fmt(d.deletion.completedAt)}. This record is kept for a while.</div>}

      <h2 className="section-h">Received files</h2>
      {files.length === 0 ? (
        <p className="muted">{open ? 'Nothing has arrived yet. You will get a notification when it does.' : 'Nothing was received.'}</p>
      ) : (
        <ul className="files-plain files-in" aria-live="polite">
          {files.map((f) => {
            const s = fileState(f);
            return (
              <li key={f.id}>
                <span style={{ minWidth: 0 }}>
                  <span className="fname">{f.displayName}</span>
                  <span className="small muted" style={{ display: 'block', overflowWrap: 'anywhere' }}>
                    {f.uploadedByEmail ? `from ${f.uploadedByEmail}` : 'sender no longer recorded'} · <span className="num">{formatBytes(f.sizeBytes)}</span> · <span className={`fstate ${s.tone}`}>{s.text}</span>
                  </span>
                </span>
                {s.downloadable && isLive && (
                  <a className="btn btn-sm" href={`/api/transfers/${d.id}/files/${f.id}/download`} download={f.displayName} aria-label={`Download ${f.displayName}`}>Download</a>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {files.some((f) => f.scanStatus === 'clean') && isLive && <p className="hint">Files were checked for malware when they arrived. Open them on a managed device all the same: no scanner catches everything.</p>}

      <h2 className="section-h">Who you asked</h2>
      {d.grants.length === 0 ? (
        <p className="muted">No one yet.</p>
      ) : (
        <div className="people">
          {d.grants.map((g) => {
            const endedByClose = closed && g.status === 'revoked' && !!g.revokedAt && new Date(g.revokedAt).getTime() >= new Date(d.closedAt!).getTime() - 1000;
            const removed = g.status === 'revoked' && !endedByClose;
            return (
              <div className="person" key={g.id}>
                <div>
                  <div className="em" style={{ textDecoration: removed ? 'line-through' : undefined }}>{g.email}</div>
                  <div className="sub">
                    {g.addedAfterSend ? 'Added later · ' : ''}
                    {removed ? `Removed ${fmt(g.revokedAt)}` : endedByClose ? 'Link ended when the request was closed' : g.firstLinkSeenAt && !g.firstVerifiedAt ? 'Link fetched but not verified (could be a scanner)' : ''}
                  </div>
                </div>
                <RequestSteps g={g} open={open} endedByClose={endedByClose} />
                <div className="acts">
                  {open && g.status === 'invited' && (
                    <details className="menu-btn">
                      <summary className="btn btn-sm" aria-label={`Actions for ${g.email}`}>···</summary>
                      <div className="menu">
                        <button type="button" onClick={() => { closeMenus(); void nudge(g, 'remind'); }}>Send a reminder</button>
                        <button type="button" onClick={() => { closeMenus(); void nudge(g, 'resend'); }}>Send a fresh link</button>
                        <button type="button" className="danger" onClick={() => { closeMenus(); setGrant(g); setErr(null); setDialog('remove'); }}>Remove</button>
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {d.message && (
        <>
          <h2 className="section-h">Your note to them</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{d.message}</p>
        </>
      )}

      <details className="history" style={{ marginTop: 24 }}>
        <summary>Full history ({act.data?.events.length ?? 0} events)</summary>
        <p className="small muted">Times in your time zone. A fetched link is not a human view; mail-server acceptance is not inbox delivery.</p>
        <Receipt events={act.data?.events ?? []} fileNames={fileNames} />
        <p className="small muted" style={{ marginTop: 10 }}>Requested by {d.senderEmail} · policy version {String(d.effectivePolicy.policyVersionId ?? 'defaults')}</p>
      </details>

      <Dialog title={dialog === 'close' ? 'Close to new files' : dialog === 'remove' ? `Remove ${grant?.email}` : dialog === 'add' ? 'Add someone' : dialog === 'extend' ? 'Change closing date' : 'Delete everything now'} open={dialog !== null} onClose={() => setDialog(null)}>
        <form onSubmit={submit} id="rq-form">
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          {dialog === 'close' && (
            <p>
              Every link you sent stops working straight away and any upload still in progress is cancelled. Files already received are kept until the closing date ({fmtLong(d.expiresAt)}), then deleted. A closed request cannot be reopened.
            </p>
          )}
          {dialog === 'remove' && <p>Their link and any open session stop working immediately. Files they have already sent are kept. Other people you asked are unaffected.</p>}
          {dialog === 'delete' && <p>Every link stops working and every received file is deleted now, including any you have not downloaded. The deletion is verified and the history is kept.</p>}
          {dialog === 'add' && (
            <div className="field">
              <label htmlFor="rq-email">Email address</label>
              <input id="rq-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              <span className="hint">They get their own link and code. They cannot see what anyone else has sent.</span>
            </div>
          )}
          {dialog === 'extend' && (
            <div className="field">
              <label htmlFor="rq-exp">Closing date</label>
              <input id="rq-exp" className="input" type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} required />
              <span className="hint">Limited by policy, counted from when you asked. Received files are deleted on this date.</span>
            </div>
          )}
          {dialog !== 'delete' && (
            <div className="field">
              <label htmlFor="rq-reason">Why? {dialog === 'add' || dialog === 'extend' ? '(required, kept in the history)' : '(optional, kept in the history)'}</label>
              <input id="rq-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} required={dialog === 'add' || dialog === 'extend'} maxLength={500} />
            </div>
          )}
        </form>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="rq-form" className={`btn ${dialog === 'add' || dialog === 'extend' ? 'btn-primary' : 'btn-danger'}`} disabled={m.isPending}>
            {dialog === 'close' ? 'Close request' : dialog === 'remove' ? 'Remove' : dialog === 'add' ? 'Send invitation' : dialog === 'extend' ? 'Save' : 'Delete now'}
          </button>
        </div>
      </Dialog>
    </>
  );
}
