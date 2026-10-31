import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, type ActivityEvent, type GrantView, type TransferDetail } from '@snelson/shared';
import { get, post, errorMessage } from '../api';
import { Badge, TransferBadge, scanLabel, uploadLabel, grantLabel, transferState } from '../components/Status';
import { Dialog } from '../components/Dialog';
import { Receipt } from '../components/Receipt';
import { fmt, fmtLong, countdown, toLocalInput, fromLocalInput } from '../lib/time';

type DialogKind = null | 'revoke' | 'revoke-grant' | 'add-recipient' | 'extend' | 'delete';

export function TransferDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const t = useQuery({ queryKey: ['transfer', id], queryFn: () => get<TransferDetail>(`/api/transfers/${id}`), refetchInterval: (q) => (['uploading', 'scanning', 'active', 'sending'].includes(q.state.data?.status ?? '') || q.state.data?.deletionStatus === 'pending' || q.state.data?.deletionStatus === 'in_progress' ? 10_000 : false) });
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
  if (t.isError || !t.data) return <div className="notice notice-err">Transfer not found.</div>;
  const d = t.data;
  const state = transferState(d);
  const isUnsent = ['draft', 'uploading', 'scanning', 'ready'].includes(d.status);
  const isLive = d.status === 'active' && d.deletionStatus === 'none' && new Date(d.expiresAt).getTime() > Date.now();
  const fileNames = Object.fromEntries(d.files.map((f) => [f.id, f.displayName]));
  const activeGrants = d.grants.filter((g) => g.status !== 'revoked');
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
        setFlash(`A new invitation link has been queued for ${g.email}. The previous link no longer works.`);
        refresh();
      })
      .catch((e) => setFlash(errorMessage(e)));

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small"><Link to="/transfers">← Transfers</Link></p>
          <h1>
            {d.title || 'Untitled transfer'} <TransferBadge t={d} />
          </h1>
          <p>
            {d.fileCount} file{d.fileCount === 1 ? '' : 's'} · {formatBytes(d.totalBytes)} · {d.sentAt ? `sent ${fmt(d.sentAt)}` : `created ${fmt(d.createdAt)}`}
          </p>
        </div>
        <div className="row">
          {isUnsent && <Link to={`/transfers/new?id=${d.id}`} className="btn btn-primary">Continue editing</Link>}
          {isLive && d.effectivePolicy.allowExpiryExtension !== false && (
            <button className="btn" onClick={() => { setExpiry(toLocalInput(d.expiresAt)); setErr(null); setDialog('extend'); }}>Change expiry</button>
          )}
          {isLive && <button className="btn" onClick={() => { setErr(null); setDialog('add-recipient'); }}>Add recipient</button>}
          {isLive && <button className="btn btn-danger" onClick={() => { setErr(null); setDeleteNow(false); setDialog('revoke'); }}>Revoke transfer</button>}
          {!isLive && d.deletionStatus === 'none' && !isUnsent && <button className="btn btn-danger" onClick={() => { setErr(null); setDialog('delete'); }}>Delete content now</button>}
          {isUnsent && <button className="btn btn-danger" onClick={() => { setErr(null); setDialog('delete'); }}>Discard draft</button>}
        </div>
      </div>

      {flash && <div className="notice notice-info" role="status">{flash} <button className="btn-link" onClick={() => setFlash(null)}>Dismiss</button></div>}
      {d.deletionStatus === 'failed' && (
        <div className="notice notice-err" role="alert"><strong>Content deletion failed</strong>Access is denied and administrators have been alerted. Attempts: {d.deletion.attempts}. {d.deletion.lastError}</div>
      )}
      {(d.deletionStatus === 'pending' || d.deletionStatus === 'in_progress') && (
        <div className="notice notice-warn" role="status"><strong>Content deletion in progress</strong>Requested {fmt(d.deletion.requestedAt)}. Recipients can no longer download.</div>
      )}
      {d.deletionStatus === 'deleted' && (
        <div className="notice notice-info" role="status"><strong>Content deleted</strong>All file copies were removed and verified at {fmt(d.deletion.completedAt)}. This receipt is retained until metadata retention expires.</div>
      )}
      {d.status === 'expired' && d.deletionStatus !== 'deleted' && <div className="notice notice-info"><strong>Expired</strong>Access ended at {fmtLong(d.expiresAt)}.</div>}
      {d.status === 'revoked' && <div className="notice notice-warn"><strong>Revoked</strong>Access was withdrawn at {fmt(d.revokedAt)}.</div>}

      <div className="two-col">
        <div>
          <section className="card" aria-labelledby="files-h">
            <div className="card-head"><h2 id="files-h">Files</h2><span className="muted small">{formatBytes(d.totalBytes)} total</span></div>
            {d.files.length === 0 ? <p className="muted">No files.</p> : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead><tr><th scope="col">Name</th><th scope="col">Size</th><th scope="col">Upload</th><th scope="col">Scan</th><th scope="col">Storage</th></tr></thead>
                  <tbody>
                    {d.files.map((f) => {
                      const s = scanLabel(f.scanStatus);
                      const u = uploadLabel(f.uploadStatus);
                      return (
                        <tr key={f.id}>
                          <td style={{ overflowWrap: 'anywhere' }}>{f.displayName}</td>
                          <td className="num">{formatBytes(f.sizeBytes)}</td>
                          <td><Badge tone={u.tone} label={u.label} /></td>
                          <td><Badge tone={s.tone} label={s.label} title={f.scanDetail ?? undefined} />{f.scanDetail && f.scanStatus !== 'clean' ? <div className="small muted">{f.scanDetail}</div> : null}</td>
                          <td className="small">{f.storageState === 'released' ? 'Available' : f.storageState === 'quarantine' ? 'Quarantined' : f.storageState === 'deleted' ? 'Deleted' : f.storageState}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="rcpt-h">
            <div className="card-head"><h2 id="rcpt-h">Recipients</h2><span className="muted small">{d.grants.filter((g) => g.allFilesCompletedAt).length} of {activeGrants.length} downloaded everything</span></div>
            {d.grants.length === 0 ? <p className="muted">No recipients yet.</p> : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead><tr><th scope="col">Recipient</th><th scope="col">Invitation</th><th scope="col">Verified</th><th scope="col">Downloads</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
                  <tbody>
                    {d.grants.map((g) => {
                      const gl = grantLabel(g.status);
                      return (
                        <tr key={g.id}>
                          <td>
                            {g.email}
                            {g.addedAfterSend && <div className="small muted">added after sending</div>}
                            <div><Badge tone={gl.tone} label={gl.label} /></div>
                          </td>
                          <td className="small">
                            {g.invitationStatus === 'accepted_by_provider' && 'Accepted by mail server'}
                            {g.invitationStatus === 'queued' && 'Queued'}
                            {g.invitationStatus === 'failed' && <span style={{ color: 'var(--red)' }}>Failed to send</span>}
                            {g.invitationStatus === 'suppressed' && 'Suppressed'}
                            {g.invitationStatus === 'none' && (d.sentAt ? '—' : 'Not sent yet')}
                            {g.invitedAt && <div className="muted">{fmt(g.invitedAt)}</div>}
                            {g.firstLinkSeenAt && <div className="muted">Link first fetched {fmt(g.firstLinkSeenAt)} (unverified)</div>}
                          </td>
                          <td className="small">
                            {d.verificationMode === 'bearer' ? <span className="muted">Bearer link: identity not verified</span> : g.firstVerifiedAt ? <>Yes, {fmt(g.firstVerifiedAt)}</> : <span className="muted">Not yet</span>}
                          </td>
                          <td className="small">
                            {g.filesCompleted}/{d.files.filter((f) => f.storageState === 'released').length} files complete
                            {g.allFilesCompletedAt && <div><Badge tone="ok" label="All files downloaded" /></div>}
                            {d.downloadLimitPerRecipient !== null && <div className="muted">{g.downloadsUsed} of {d.downloadLimitPerRecipient} allowances used</div>}
                          </td>
                          <td className="small">
                            {isLive && g.status === 'invited' && (
                              <div className="row">
                                <button className="btn btn-sm" onClick={() => void resend(g)}>Resend</button>
                                <button className="btn btn-sm btn-danger" onClick={() => { setGrant(g); setErr(null); setDialog('revoke-grant'); }}>Revoke</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {d.message && (
            <section className="card" aria-labelledby="msg-h">
              <h2 id="msg-h">Message to recipients</h2>
              <p style={{ whiteSpace: 'pre-wrap' }}>{d.message}</p>
            </section>
          )}
        </div>
        <aside>
          <section className="card" aria-labelledby="pol-h">
            <h2 id="pol-h">Access policy</h2>
            <dl className="kv">
              <dt>State</dt><dd>{state.label}</dd>
              <dt>Expires</dt><dd>{fmtLong(d.expiresAt)}<div className="small muted">{countdown(d.expiresAt)}</div></dd>
              <dt>Verification</dt><dd>{d.verificationMode === 'required' ? 'Email code required for every recipient' : 'Bearer link: anyone holding the link can download'}</dd>
              <dt>Download limit</dt><dd>{d.downloadLimitPerRecipient === null ? 'Unlimited per recipient' : `${d.downloadLimitPerRecipient} per recipient per file`}</dd>
              <dt>Notifications</dt><dd className="small">{Object.entries(d.notifyPrefs).filter(([, v]) => v).map(([k]) => prefLabel(k)).join(', ') || 'None'}</dd>
              <dt>Policy version</dt><dd className="small">{String(d.effectivePolicy.policyVersionId ?? 'defaults')}</dd>
              <dt>Sender</dt><dd className="small">{d.senderEmail}</dd>
            </dl>
          </section>
          <section className="card" aria-labelledby="act-h">
            <h2 id="act-h">Activity receipt</h2>
            <p className="small muted">Times shown in your time zone. A fetched link is not a human view; mail-server acceptance is not inbox delivery.</p>
            <Receipt events={act.data?.events ?? []} fileNames={fileNames} />
          </section>
        </aside>
      </div>

      <Dialog title={dialog === 'revoke' ? 'Revoke this transfer' : dialog === 'revoke-grant' ? `Revoke access for ${grant?.email}` : dialog === 'add-recipient' ? 'Add a recipient' : dialog === 'extend' ? 'Change expiry' : isUnsent ? 'Discard draft' : 'Delete content now'} open={dialog !== null} onClose={() => setDialog(null)}>
        <form onSubmit={submit} id="dlg-form">
          {err && <div className="notice notice-err" role="alert">{err}</div>}
          {dialog === 'revoke' && (
            <>
              <p>All recipient links and sessions stop working immediately; active downloads are cut off within a few seconds. Bytes already delivered cannot be recalled.</p>
              <label className="check"><input type="checkbox" checked={deleteNow} onChange={(e) => setDeleteNow(e.target.checked)} /><span>Also delete the file content now<small>Otherwise content is deleted at the original expiry.</small></span></label>
            </>
          )}
          {dialog === 'revoke-grant' && <p>This recipient's link and any active session stop working immediately. Other recipients are unaffected.</p>}
          {dialog === 'delete' && <p>{isUnsent ? 'The draft and any uploaded files will be deleted.' : 'Every stored copy of the files will be deleted and the deletion verified. The activity receipt is kept.'}</p>}
          {dialog === 'add-recipient' && (
            <div className="field">
              <label htmlFor="add-email">Email address</label>
              <input id="add-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              <span className="hint">A fresh invitation with its own link is sent. This is recorded in the receipt.</span>
            </div>
          )}
          {dialog === 'extend' && (
            <div className="field">
              <label htmlFor="exp">New expiry</label>
              <input id="exp" className="input" type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} required />
              <span className="hint">Cannot exceed the policy maximum measured from the send time. Deleted content can never be restored by extending.</span>
            </div>
          )}
          {dialog !== 'delete' && (
            <div className="field">
              <label htmlFor="reason">Reason {dialog === 'add-recipient' || dialog === 'extend' ? '(required, audited)' : '(optional, audited)'}</label>
              <input id="reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} required={dialog === 'add-recipient' || dialog === 'extend'} maxLength={500} />
            </div>
          )}
        </form>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
          <button type="submit" form="dlg-form" className={`btn ${dialog === 'add-recipient' || dialog === 'extend' ? 'btn-primary' : 'btn-danger'}`} disabled={m.isPending}>
            {dialog === 'revoke' ? 'Revoke' : dialog === 'revoke-grant' ? 'Revoke access' : dialog === 'add-recipient' ? 'Send invitation' : dialog === 'extend' ? 'Save expiry' : isUnsent ? 'Discard' : 'Delete now'}
          </button>
        </div>
      </Dialog>
    </>
  );
}

export function prefLabel(k: string): string {
  return (
    {
      firstVerifiedView: 'first verified view',
      firstDownload: 'first / all-files download',
      everyDownload: 'every download',
      expiringSoon: 'expiring soon',
      expiredWithoutDownload: 'expired without download',
      deletionCompleted: 'deletion completed',
    } as Record<string, string>
  )[k] ?? k;
}
