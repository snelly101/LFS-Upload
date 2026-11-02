import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, type ActivityEvent, type GrantView, type TransferDetail } from '@securesend/shared';
import { get, post, errorMessage } from '../api';
import { transferState } from '../components/Status';
import { Dialog } from '../components/Dialog';
import { Receipt } from '../components/Receipt';
import { Steps, headline } from '../components/Steps';
import { fmt, fmtLong, countdown, toLocalInput, fromLocalInput } from '../lib/time';
import { refCode } from '../lib/labels';

export { prefLabel } from '../lib/labels';

type DialogKind = null | 'revoke' | 'revoke-grant' | 'add-recipient' | 'extend' | 'delete';

export function TransferDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const t = useQuery({
    queryKey: ['transfer', id],
    queryFn: () => get<TransferDetail>(`/api/transfers/${id}`),
    refetchInterval: (q) => (['uploading', 'scanning', 'active', 'sending'].includes(q.state.data?.status ?? '') || q.state.data?.deletionStatus === 'pending' || q.state.data?.deletionStatus === 'in_progress' ? 10_000 : false),
  });
  const act = useQuery({ queryKey: ['transfer-activity', id], queryFn: () => get<{ events: ActivityEvent[] }>(`/api/transfers/${id}/activity`), refetchInterval: 15_000 });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [grant, setGrant] = useState<GrantView | null>(null);
  const [reason, setReason] = useState('');
  const [deleteNow, setDeleteNow] = useState(false);
  const [email, setEmail] = useState('');
  const [expiry, setExpiry] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['transfer', id] });
    void qc.invalidateQueries({ queryKey: ['transfer-activity', id] });
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

  if (t.isLoading) return <p>Loading…</p>;
  if (t.isError || !t.data) return <div className="notice notice-err">We couldn't find that transfer.</div>;
  const d = t.data;
  const state = transferState(d);
  const isUnsent = ['draft', 'uploading', 'scanning', 'ready'].includes(d.status);
  const isLive = d.status === 'active' && d.deletionStatus === 'none' && new Date(d.expiresAt).getTime() > Date.now();
  const fileNames = Object.fromEntries(d.files.map((f) => [f.id, f.displayName]));
  const releasedCount = d.files.filter((f) => f.storageState === 'released').length;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dialog === 'revoke') m.mutate({ url: `/api/transfers/${d.id}/revoke`, body: { reason, deleteNow } });
    if (dialog === 'revoke-grant' && grant) m.mutate({ url: `/api/transfers/${d.id}/grants/${grant.id}/revoke`, body: { reason } });
    if (dialog === 'add-recipient') m.mutate({ url: `/api/transfers/${d.id}/recipients`, body: { email, reason } });
    if (dialog === 'extend') m.mutate({ url: `/api/transfers/${d.id}/extend`, body: { expiresAt: fromLocalInput(expiry), reason } });
    if (dialog === 'delete') m.mutate({ url: `/api/transfers/${d.id}/delete-now`, body: {} });
  };
  const resend = (g: GrantView) =>
    post(`/api/transfers/${d.id}/grants/${g.id}/resend`)
      .then(() => {
        setFlash(`A fresh link is on its way to ${g.email}. The old link no longer works.`);
        refresh();
      })
      .catch((e) => setFlash(errorMessage(e)));

  return (
    <>
      <p className="small" style={{ marginBottom: 14 }}><Link to="/sent">← Sent</Link></p>
      <h1 className="lede">{headline(d)}</h1>
      <p className="lede-sub">
        <strong>{d.title || 'Untitled'}</strong> · {d.fileCount} file{d.fileCount === 1 ? '' : 's'}, {formatBytes(d.totalBytes)} · {d.sentAt ? `sent ${fmt(d.sentAt)}` : `started ${fmt(d.createdAt)}`} · <span className="mono small">REF {refCode(d.id)}</span>
      </p>
      <p className="facts">
        <span><strong className={`word word-${state.tone}`}>{state.label}</strong></span>
        <span>{isLive ? <>Until <strong>{fmtLong(d.expiresAt)}</strong> ({countdown(d.expiresAt)})</> : <>Expiry was {fmtLong(d.expiresAt)}</>}</span>
        <span>{d.verificationMode === 'required' ? 'Email code required' : 'No verification (bearer link)'}</span>
        {d.downloadLimitPerRecipient !== null && <span>Max {d.downloadLimitPerRecipient} download{d.downloadLimitPerRecipient === 1 ? '' : 's'} per recipient per file</span>}
      </p>
      <div className="actions">
        {isUnsent && <Link to={`/?id=${d.id}`} className="btn btn-primary">Continue</Link>}
        {isLive && <button className="btn" onClick={() => { setErr(null); setEmail(''); setDialog('add-recipient'); }}>Add someone</button>}
        {isLive && d.effectivePolicy.allowExpiryExtension !== false && <button className="btn" onClick={() => { setExpiry(toLocalInput(d.expiresAt)); setErr(null); setDialog('extend'); }}>Change expiry</button>}
        {isLive && <button className="btn btn-danger" onClick={() => { setErr(null); setDeleteNow(false); setDialog('revoke'); }}>Stop sharing</button>}
        {!isLive && !isUnsent && d.deletionStatus === 'none' && <button className="btn btn-danger" onClick={() => { setErr(null); setDialog('delete'); }}>Delete files now</button>}
        {isUnsent && <button className="btn btn-danger" onClick={() => { setErr(null); setDialog('delete'); }}>Discard</button>}
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => window.location.assign('/')}>Send more files</button>
      </div>

      {flash && <div className="notice notice-info" role="status">{flash} <button className="btn-link" onClick={() => setFlash(null)}>Dismiss</button></div>}
      {d.deletionStatus === 'failed' && <div className="notice notice-err" role="alert"><strong>Deletion failed</strong>Downloads are blocked and administrators have been alerted. Attempts: {d.deletion.attempts}. {d.deletion.lastError}</div>}
      {(d.deletionStatus === 'pending' || d.deletionStatus === 'in_progress') && <div className="notice notice-warn" role="status"><strong>Deleting files</strong>Requested {fmt(d.deletion.requestedAt)}. Nobody can download any more.</div>}
      {d.deletionStatus === 'deleted' && <div className="notice notice-info" role="status"><strong>Files deleted</strong>Every copy was removed and verified at {fmt(d.deletion.completedAt)}. This record is kept for a while.</div>}
      {d.status === 'revoked' && d.deletionStatus === 'none' && <div className="notice notice-warn"><strong>Sharing stopped</strong>Access was withdrawn at {fmt(d.revokedAt)}. Files will be deleted at the original expiry.</div>}

      <h2 className="section-h">Recipients</h2>
      {d.grants.length === 0 ? (
        <p className="muted">No one yet.</p>
      ) : (
        <div className="people">
          {d.grants.map((g) => (
            <div className="person" key={g.id}>
              <div>
                <div className="em" style={{ textDecoration: g.status === 'revoked' ? 'line-through' : undefined }}>{g.email}</div>
                <div className="sub">
                  {g.addedAfterSend ? 'Added after sending · ' : ''}
                  {g.status === 'revoked' ? `Access revoked ${fmt(g.revokedAt)}` : d.downloadLimitPerRecipient !== null ? `${g.downloadsUsed} of ${d.downloadLimitPerRecipient} downloads used` : g.firstLinkSeenAt && !g.firstVerifiedAt ? 'Link fetched but not verified (could be a scanner)' : ''}
                </div>
              </div>
              <Steps g={g} totalFiles={releasedCount} verificationMode={d.verificationMode} transferLive={isLive} />
              <div className="acts">
                {isLive && g.status === 'invited' && (
                  <details className="menu-btn">
                    <summary className="btn btn-sm" aria-label={`Actions for ${g.email}`}>⋯</summary>
                    <div className="menu">
                      <button type="button" onClick={() => void resend(g)}>Send a fresh link</button>
                      <button type="button" className="danger" onClick={() => { setGrant(g); setErr(null); setDialog('revoke-grant'); }}>Remove access</button>
                    </div>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-h">Files</h2>
      <ul className="files-plain">
        {d.files.map((f) => (
          <li key={f.id}>
            <span style={{ overflowWrap: 'anywhere' }}>
              {f.displayName}
              {f.scanStatus !== 'clean' && <span className="small" style={{ color: f.scanStatus === 'infected' ? 'var(--red)' : 'var(--amber)' }}> · {f.scanStatus === 'infected' ? 'blocked by malware scan' : f.scanStatus === 'oversized' ? 'not scanned (too large)' : `scan ${f.scanStatus}`}</span>}
              {f.storageState === 'deleted' && <span className="small muted"> · deleted</span>}
            </span>
            <span className="sz">{formatBytes(f.sizeBytes)}</span>
          </li>
        ))}
      </ul>

      {d.message && (
        <>
          <h2 className="section-h">Note to recipients</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{d.message}</p>
        </>
      )}

      <details className="history" style={{ marginTop: 24 }}>
        <summary>Full history ({act.data?.events.length ?? 0} events)</summary>
        <p className="small muted">Times in your time zone. A fetched link is not a human view; mail-server acceptance is not inbox delivery.</p>
        <Receipt events={act.data?.events ?? []} fileNames={fileNames} />
        <p className="small muted" style={{ marginTop: 10 }}>Sender {d.senderEmail} · policy version {String(d.effectivePolicy.policyVersionId ?? 'defaults')} · notifications: {Object.entries(d.notifyPrefs).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}</p>
      </details>

      <Dialog title={dialog === 'revoke' ? 'Stop sharing' : dialog === 'revoke-grant' ? `Remove access for ${grant?.email}` : dialog === 'add-recipient' ? 'Add someone' : dialog === 'extend' ? 'Change expiry' : isUnsent ? 'Discard this transfer' : 'Delete files now'} open={dialog !== null} onClose={() => setDialog(null)}>
        <form onSubmit={submit} id="dlg-form">
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          {dialog === 'revoke' && (
            <>
              <p>Every link stops working immediately and any download in progress is cut off within a few seconds. Anything already downloaded stays downloaded.</p>
              <label className="check"><input type="checkbox" checked={deleteNow} onChange={(e) => setDeleteNow(e.target.checked)} /><span>Also delete the files now<small>Otherwise they are deleted at the original expiry.</small></span></label>
            </>
          )}
          {dialog === 'revoke-grant' && <p>Their link and any open session stop working immediately. Other recipients are unaffected.</p>}
          {dialog === 'delete' && <p>{isUnsent ? 'The uploaded files are removed and this draft disappears.' : 'Every stored copy is deleted and the deletion verified. The history is kept.'}</p>}
          {dialog === 'add-recipient' && (
            <div className="field">
              <label htmlFor="add-email">Email address</label>
              <input id="add-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              <span className="hint">They get their own link and code, same as everyone else. This is recorded in the history.</span>
            </div>
          )}
          {dialog === 'extend' && (
            <div className="field">
              <label htmlFor="exp">Available until</label>
              <input id="exp" className="input" type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} required />
              <span className="hint">Limited by policy, counted from when it was sent. Files that have been deleted cannot come back.</span>
            </div>
          )}
          {dialog !== 'delete' && (
            <div className="field">
              <label htmlFor="reason">Why? {dialog === 'add-recipient' || dialog === 'extend' ? '(required, kept in the history)' : '(optional, kept in the history)'}</label>
              <input id="reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} required={dialog === 'add-recipient' || dialog === 'extend'} maxLength={500} />
            </div>
          )}
        </form>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="dlg-form" className={`btn ${dialog === 'add-recipient' || dialog === 'extend' ? 'btn-primary' : 'btn-danger'}`} disabled={m.isPending}>
            {dialog === 'revoke' ? 'Stop sharing' : dialog === 'revoke-grant' ? 'Remove access' : dialog === 'add-recipient' ? 'Send invitation' : dialog === 'extend' ? 'Save' : isUnsent ? 'Discard' : 'Delete now'}
          </button>
        </div>
      </Dialog>
    </>
  );
}
