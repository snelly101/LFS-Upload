import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import * as tus from 'tus-js-client';
import { formatBytes, formatDuration, formatRate, type TransferDetail, type TransferFileView, type TransferPolicy } from '@snelson/shared';
import { get, post, patch, put, del, errorMessage } from '../api';
import { Badge, scanLabel } from '../components/Status';
import { fmtLong, toLocalInput, fromLocalInput } from '../lib/time';
import { prefLabel } from './TransferDetail';

interface PolicyResponse {
  transferPolicy: TransferPolicy;
  verification: { mode: 'required' | 'sender_choice' | 'disabled'; codeTtlSeconds: number; locked: boolean };
  notifications: { senderChoices: Record<string, boolean>; defaults: Record<string, boolean> };
  quota: { quotaBytes: number; usedBytes: number; reservedBytes: number };
  disk: { availableBytes: number; totalBytes: number };
  scannerMaxBytes: number;
}

interface LocalUpload {
  key: string;
  file: File;
  record: TransferFileView | null;
  uploadId: string | null;
  upload: tus.Upload | null;
  sent: number;
  speed: number;
  status: 'registering' | 'queued' | 'uploading' | 'paused' | 'done' | 'error';
  error: string | null;
  startedAt: number;
  lastTick: { t: number; b: number };
}

const CHUNK = 8 * 1024 * 1024;
const PARALLEL = 2;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function NewTransferPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const existingId = params.get('id');
  const policyQ = useQuery({ queryKey: ['transfer-policy'], queryFn: () => get<PolicyResponse>('/api/transfers/policy') });
  const [transfer, setTransfer] = useState<TransferDetail | null>(null);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [expiry, setExpiry] = useState('');
  const [verification, setVerification] = useState<'required' | 'bearer'>('required');
  const [limit, setLimit] = useState<string>('');
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [emails, setEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<TransferDetail | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const transferRef = useRef<TransferDetail | null>(null);
  transferRef.current = transfer;
  const fileInput = useRef<HTMLInputElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const policy = policyQ.data;

  // initialise from policy defaults / existing draft
  useEffect(() => {
    if (!policy) return;
    if (existingId) {
      get<TransferDetail>(`/api/transfers/${existingId}`)
        .then((t) => {
          setTransfer(t);
          setTitle(t.title);
          setMessage(t.message);
          setExpiry(toLocalInput(t.expiresAt));
          setVerification(t.verificationMode);
          setLimit(t.downloadLimitPerRecipient === null ? '' : String(t.downloadLimitPerRecipient));
          setPrefs(t.notifyPrefs);
          setEmails(t.grants.filter((g) => g.status !== 'revoked').map((g) => g.email));
          setUploads(
            t.files.map((f) => ({
              key: f.id,
              file: new File([], f.displayName),
              record: f,
              uploadId: null,
              upload: null,
              sent: f.uploadedBytes,
              speed: 0,
              status: f.uploadStatus === 'finalised' ? 'done' : f.uploadStatus === 'abandoned' ? 'error' : 'paused',
              error: f.uploadStatus === 'finalised' ? null : 'Re-select this file to resume the upload.',
              startedAt: 0,
              lastTick: { t: 0, b: 0 },
            })),
          );
        })
        .catch((e) => setErr(errorMessage(e)));
    } else {
      setExpiry(toLocalInput(new Date(Date.now() + policy.transferPolicy.defaultExpiryHours * 3_600_000).toISOString()));
      setPrefs(policy.notifications.defaults);
    }
  }, [policy, existingId]);

  // poll transfer while files scan
  useEffect(() => {
    if (!transfer) return;
    const needs = transfer.files.some((f) => f.scanStatus === 'pending' || f.scanStatus === 'scanning');
    if (!needs) return;
    const id = setInterval(() => {
      get<TransferDetail>(`/api/transfers/${transfer.id}`).then((t) => {
        setTransfer(t);
        setUploads((us) => us.map((u) => ({ ...u, record: t.files.find((f) => f.id === u.record?.id) ?? u.record })));
      }).catch(() => undefined);
    }, 4000);
    return () => clearInterval(id);
  }, [transfer]);

  const dispatchBody = useCallback(
    () => ({
      title,
      message,
      expiresAt: expiry ? fromLocalInput(expiry) : undefined,
      verificationMode: verification,
      downloadLimitPerRecipient: limit === '' ? null : Number(limit),
      notifyPrefs: prefs,
    }),
    [title, message, expiry, verification, limit, prefs],
  );

  /** Create the draft lazily on first need. */
  const ensureTransfer = useCallback(async (): Promise<TransferDetail> => {
    if (transferRef.current) return transferRef.current;
    const t = await post<TransferDetail>('/api/transfers', dispatchBody());
    transferRef.current = t;
    setTransfer(t);
    return t;
  }, [dispatchBody]);

  const announce = (msg: string) => {
    if (liveRef.current) liveRef.current.textContent = msg;
  };

  const update = (key: string, patchFn: (u: LocalUpload) => Partial<LocalUpload>) => setUploads((us) => us.map((u) => (u.key === key ? { ...u, ...patchFn(u) } : u)));

  const startUpload = useCallback(
    (u: LocalUpload, record: TransferFileView, uploadId: string) => {
      const upload = new tus.Upload(u.file, {
        endpoint: '/api/uploads/tus',
        chunkSize: CHUNK,
        retryDelays: [1000, 3000, 5000, 10000, 20000],
        metadata: { uploadId, filename: u.file.name },
        headers: { 'X-Requested-With': 'snelson' },
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        fingerprint: async () => `snelson:${uploadId}`,
        onProgress: (bytesSent) => {
          setUploads((us) =>
            us.map((x) => {
              if (x.key !== u.key) return x;
              const now = Date.now();
              const dt = (now - x.lastTick.t) / 1000;
              const speed = dt >= 1 ? (bytesSent - x.lastTick.b) / dt : x.speed;
              return { ...x, sent: bytesSent, speed: dt >= 1 ? speed : x.speed, lastTick: dt >= 1 ? { t: now, b: bytesSent } : x.lastTick };
            }),
          );
        },
        onSuccess: () => {
          update(u.key, () => ({ status: 'done', sent: record.sizeBytes, speed: 0 }));
          announce(`${u.file.name} uploaded; scanning.`);
          get<TransferDetail>(`/api/transfers/${record ? transferRef.current!.id : ''}`).then((t) => {
            setTransfer(t);
            setUploads((us) => us.map((x) => ({ ...x, record: t.files.find((f) => f.id === x.record?.id) ?? x.record })));
          }).catch(() => undefined);
        },
        onError: (e) => {
          update(u.key, () => ({ status: 'error', error: e.message.replace(/, request id.*$/, '') }));
          announce(`${u.file.name} failed: ${e.message}`);
        },
        onShouldRetry: (e, retryAttempt) => {
          const status = (e as tus.DetailedError).originalResponse?.getStatus() ?? 0;
          if (status === 401 || status === 403 || status === 404 || status === 409 || status === 413) return false;
          return retryAttempt < 5;
        },
      });
      update(u.key, () => ({ upload, uploadId, record, status: 'uploading', startedAt: Date.now(), lastTick: { t: Date.now(), b: 0 } }));
      upload.findPreviousUploads().then((prev) => {
        if (prev.length) upload.resumeFromPreviousUpload(prev[0]!);
        upload.start();
      });
    },
    [],
  );

  // scheduler: keep PARALLEL uploads running
  useEffect(() => {
    const running = uploads.filter((u) => u.status === 'uploading').length;
    const next = uploads.filter((u) => u.status === 'queued').slice(0, Math.max(0, PARALLEL - running));
    for (const u of next) {
      if (!u.record || !u.uploadId) continue;
      startUpload(u, u.record, u.uploadId);
    }
  }, [uploads, startUpload]);

  const addFiles = async (files: FileList | File[]) => {
    setErr(null);
    const list = Array.from(files);
    if (!list.length) return;
    let t: TransferDetail;
    try {
      t = await ensureTransfer();
    } catch (e) {
      setErr(errorMessage(e));
      return;
    }
    for (const file of list) {
      const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 6)}`;
      // Resume case: a record for this name+size is still open → reuse its upload id
      const open = uploads.find((u) => u.record && u.record.uploadStatus !== 'finalised' && u.record.uploadStatus !== 'abandoned' && u.record.displayName === file.name && u.record.sizeBytes === file.size && !u.upload);
      if (open) {
        // The upload id is only returned at registration; we keep it in localStorage so a refresh can resume.
        const id = open.uploadId ?? recallUploadId(t.id, file);
        if (id) {
          setUploads((us) => us.map((u) => (u.key === open.key ? { ...u, file, uploadId: id, status: 'queued', error: null } : u)));
          continue;
        }
      }
      setUploads((us) => [...us, { key, file, record: null, uploadId: null, upload: null, sent: 0, speed: 0, status: 'registering', error: null, startedAt: 0, lastTick: { t: 0, b: 0 } }]);
      try {
        const r = await post<{ file: TransferFileView; uploadId: string }>(`/api/transfers/${t.id}/files`, { name: file.name, sizeBytes: file.size, contentType: file.type || 'application/octet-stream' });
        rememberUploadId(t.id, file, r.uploadId);
        setUploads((us) => us.map((u) => (u.key === key ? { ...u, record: r.file, uploadId: r.uploadId, status: 'queued' } : u)));
      } catch (e) {
        setUploads((us) => us.map((u) => (u.key === key ? { ...u, status: 'error', error: errorMessage(e) } : u)));
      }
    }
    // refresh transfer totals
    get<TransferDetail>(`/api/transfers/${t.id}`).then(setTransfer).catch(() => undefined);
  };

  const pause = (u: LocalUpload) => {
    u.upload?.abort(false);
    update(u.key, () => ({ status: 'paused', speed: 0 }));
  };
  const resume = (u: LocalUpload) => {
    if (u.file.size === 0 && u.record && u.record.sizeBytes > 0) {
      fileInput.current?.click();
      return;
    }
    update(u.key, () => ({ status: 'queued', error: null }));
  };
  const remove = async (u: LocalUpload) => {
    await u.upload?.abort(true).catch(() => undefined);
    if (u.record && transfer) await del(`/api/transfers/${transfer.id}/files/${u.record.id}`).catch(() => undefined);
    setUploads((us) => us.filter((x) => x.key !== u.key));
    if (transfer) get<TransferDetail>(`/api/transfers/${transfer.id}`).then(setTransfer).catch(() => undefined);
  };

  // recipients chip input
  const commitEmail = () => {
    const parts = emailDraft.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return;
    setEmails((e) => [...new Set([...e, ...parts])]);
    setEmailDraft('');
  };
  const onEmailKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', ' ', 'Tab'].includes(e.key) && emailDraft.trim()) {
      e.preventDefault();
      commitEmail();
    } else if (e.key === 'Backspace' && !emailDraft && emails.length) {
      setEmails((x) => x.slice(0, -1));
    }
  };
  const invalidEmails = emails.filter((e) => !EMAIL_RE.test(e));
  const domainBlocked = useMemo(() => {
    const allowed = policy?.transferPolicy.allowedRecipientDomains ?? [];
    if (!allowed.length) return [];
    return emails.filter((e) => {
      const dom = e.split('@')[1] ?? '';
      return !allowed.some((d) => dom === d.toLowerCase() || dom.endsWith('.' + d.toLowerCase()));
    });
  }, [emails, policy]);

  const totalBytes = uploads.reduce((n, u) => n + (u.record?.sizeBytes ?? u.file.size), 0);
  const sentBytes = uploads.reduce((n, u) => n + (u.status === 'done' ? (u.record?.sizeBytes ?? u.file.size) : u.sent), 0);
  const speed = uploads.filter((u) => u.status === 'uploading').reduce((n, u) => n + u.speed, 0);
  const eta = speed > 0 ? (totalBytes - sentBytes) / speed : NaN;
  const uploading = uploads.some((u) => u.status === 'uploading' || u.status === 'queued' || u.status === 'registering');
  const allDone = uploads.length > 0 && uploads.every((u) => u.status === 'done');
  const scanning = transfer?.files.some((f) => f.scanStatus === 'pending' || f.scanStatus === 'scanning') ?? false;
  const blockers: string[] = [];
  if (uploads.length === 0) blockers.push('Add at least one file.');
  if (uploading) blockers.push('Wait for uploads to finish.');
  if (uploads.some((u) => u.status === 'error' || u.status === 'paused')) blockers.push('Resume or remove paused/failed files.');
  if (scanning) blockers.push('Malware scanning in progress.');
  for (const f of transfer?.files ?? []) {
    if (f.scanStatus === 'infected') blockers.push(`${f.displayName} was blocked by the malware scanner; remove it.`);
    else if (['error', 'unavailable', 'timeout', 'skipped'].includes(f.scanStatus)) blockers.push(`${f.displayName}: scan ${f.scanStatus}; it will be retried, or remove it.`);
    else if (f.scanStatus === 'oversized' && !policy?.transferPolicy.allowUnscannedOversizedRelease) blockers.push(`${f.displayName} is larger than the scanner limit and cannot be released.`);
  }
  if (emails.length === 0) blockers.push('Add at least one recipient.');
  if (invalidEmails.length) blockers.push(`Fix invalid addresses: ${invalidEmails.join(', ')}.`);
  if (domainBlocked.length) blockers.push(`Not permitted by policy: ${domainBlocked.join(', ')}.`);
  if (!expiry) blockers.push('Choose an expiry.');
  const maxExpiry = policy ? new Date(Date.now() + policy.transferPolicy.maxExpiryHours * 3_600_000) : null;
  if (expiry && maxExpiry && new Date(fromLocalInput(expiry)) > maxExpiry) blockers.push(`Expiry cannot be later than ${fmtLong(maxExpiry)}.`);
  if (expiry && new Date(fromLocalInput(expiry)) <= new Date()) blockers.push('Expiry must be in the future.');

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (blockers.length) return;
    setSending(true);
    setErr(null);
    try {
      const t = await ensureTransfer();
      await patch(`/api/transfers/${t.id}`, dispatchBody());
      await put(`/api/transfers/${t.id}/recipients`, { emails });
      const r = await post<TransferDetail>(`/api/transfers/${t.id}/send`, {});
      setSent(r);
      for (const u of uploads) if (u.uploadId) forgetUploadId(t.id, u.file);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setSending(false);
    }
  };

  // Save dispatch fields when they change (debounced) so a refresh keeps them.
  useEffect(() => {
    if (!transfer || sent) return;
    const id = setTimeout(() => {
      patch<TransferDetail>(`/api/transfers/${transfer.id}`, dispatchBody()).catch(() => undefined);
    }, 800);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, message, expiry, verification, limit, prefs]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles(e.dataTransfer.files);
  };

  if (sent) {
    return (
      <div className="card" style={{ maxWidth: 640 }}>
        <h1>Invitations are on their way</h1>
        <p>
          {sent.grants.length} recipient{sent.grants.length === 1 ? '' : 's'} will receive an email with a personal link. Files are available until <strong>{fmtLong(sent.expiresAt)}</strong>.
        </p>
        <p className="small muted">The transfer is now immutable. To change files, create a new transfer. You can add recipients or revoke access from the transfer page.</p>
        <p>
          <Link to={`/transfers/${sent.id}`} className="btn btn-primary">View transfer</Link> <Link to="/transfers/new" className="btn" onClick={() => window.location.assign('/transfers/new')}>Start another</Link>
        </p>
      </div>
    );
  }

  const summary = () => {
    if (!expiry) return null;
    const n = emails.length;
    return `Only ${n === 1 ? 'this 1 recipient' : `these ${n} recipients`} can download. ${verification === 'required' ? 'Email verification required.' : 'No email verification: anyone holding a link can download.'} Available until ${fmtLong(fromLocalInput(expiry))}.${limit ? ` At most ${limit} download${limit === '1' ? '' : 's'} per recipient per file.` : ''}`;
  };

  return (
    <form onSubmit={send}>
      <div className="page-head">
        <div>
          <h1>New transfer</h1>
          <p>Upload files, address named recipients and set the access rules. Nothing is emailed until you press Send.</p>
        </div>
        {transfer && <span className="muted small">Draft saved · {transfer.id.slice(0, 8)}</span>}
      </div>
      {err && <div className="notice notice-err" role="alert">{err}</div>}
      <div ref={liveRef} className="visually-hidden" aria-live="polite" />
      <div className="two-col">
        <section aria-labelledby="files-h">
          <h2 id="files-h" className="visually-hidden">Files</h2>
          <div className={`file-drop ${dragOver ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
            <p><strong>Drop files here</strong> or</p>
            <button type="button" className="btn" onClick={() => fileInput.current?.click()}>Choose files</button>
            <input ref={fileInput} type="file" multiple className="visually-hidden" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} aria-label="Choose files to upload" />
            {policy && (
              <p className="hint" style={{ marginTop: 10 }}>
                Up to {formatBytes(policy.transferPolicy.maxFileBytes, 0)} per file and {formatBytes(policy.transferPolicy.maxTransferBytes, 0)} per transfer. Files over {formatBytes(policy.scannerMaxBytes, 0)} cannot be malware-scanned{policy.transferPolicy.allowUnscannedOversizedRelease ? ' and will be marked as unscanned' : ' and cannot be sent'}.
                {policy.transferPolicy.blockedExtensions.length ? ` Blocked types: ${policy.transferPolicy.blockedExtensions.map((x) => '.' + x).join(', ')}.` : ''}
              </p>
            )}
          </div>
          {uploads.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="row-between">
                <strong>{allDone ? (scanning ? 'Uploaded · scanning' : 'Uploaded') : uploading ? 'Uploading' : 'Paused'}</strong>
                <span className="small num">{formatBytes(sentBytes)} of {formatBytes(totalBytes)}{speed > 0 ? ` · ${formatRate(speed)} · about ${formatDuration(eta)} left` : ''}</span>
              </div>
              <div className={`progress ${allDone ? 'progress-ok' : ''}`} style={{ marginTop: 6 }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 0} aria-label="Overall upload progress">
                <span style={{ width: `${totalBytes ? (sentBytes / totalBytes) * 100 : 0}%` }} />
              </div>
            </div>
          )}
          <ul className="file-list">
            {uploads.map((u) => {
              const size = u.record?.sizeBytes ?? u.file.size;
              const pct = size ? Math.min(100, Math.round(((u.status === 'done' ? size : u.sent) / size) * 100)) : 100;
              const sc = u.record ? scanLabel(u.record.scanStatus) : null;
              return (
                <li key={u.key} className="file-item">
                  <div className="row-between">
                    <span className="name">{u.file.name || u.record?.displayName}</span>
                    <span className="row">
                      {u.status === 'uploading' && <button type="button" className="btn btn-sm" onClick={() => pause(u)}>Pause</button>}
                      {(u.status === 'paused' || u.status === 'error') && <button type="button" className="btn btn-sm" onClick={() => resume(u)}>Resume</button>}
                      <button type="button" className="btn btn-sm" onClick={() => void remove(u)} aria-label={`Remove ${u.file.name}`}>Remove</button>
                    </span>
                  </div>
                  <div className="meta">
                    <span className="num">{formatBytes(size)}</span>
                    <span>
                      {u.status === 'registering' && 'Registering…'}
                      {u.status === 'queued' && 'Queued'}
                      {u.status === 'uploading' && `${pct}% · ${formatRate(u.speed)}${u.speed > 0 ? ` · ${formatDuration((size - u.sent) / u.speed)} left` : ''}`}
                      {u.status === 'paused' && `Paused at ${pct}% · resumable`}
                      {u.status === 'error' && <span style={{ color: 'var(--red)' }}>Interrupted: {u.error}</span>}
                      {u.status === 'done' && sc && <Badge tone={sc.tone} label={sc.label} />}
                      {u.status === 'done' && u.record?.scanDetail && u.record.scanStatus !== 'clean' && <span className="muted"> {u.record.scanDetail}</span>}
                    </span>
                  </div>
                  {u.status !== 'done' && (
                    <div className={`progress ${u.status === 'error' ? 'progress-err' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${u.file.name} progress`}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {policy && (
            <p className="hint">
              Your storage: {formatBytes(policy.quota.usedBytes + policy.quota.reservedBytes)} of {formatBytes(policy.quota.quotaBytes, 0)} used · server has {formatBytes(policy.disk.availableBytes, 0)} free.
            </p>
          )}
        </section>

        <aside className="card" aria-labelledby="dispatch-h">
          <h2 id="dispatch-h">Dispatch</h2>
          <div className="field">
            <label htmlFor="recipients">Recipients</label>
            <div className="chips" onClick={() => document.getElementById('recipients')?.focus()}>
              {emails.map((em) => (
                <span key={em} className={`chip ${!EMAIL_RE.test(em) || domainBlocked.includes(em) ? 'chip-invalid' : ''}`}>
                  {em}
                  <button type="button" aria-label={`Remove ${em}`} onClick={() => setEmails((x) => x.filter((y) => y !== em))}>×</button>
                </span>
              ))}
              <input id="recipients" type="text" value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)} onKeyDown={onEmailKey} onBlur={commitEmail} placeholder={emails.length ? '' : 'name@example.com, …'} autoComplete="off" aria-describedby="rcpt-hint" />
            </div>
            <span id="rcpt-hint" className="hint">Each recipient receives their own link{policy?.transferPolicy.allowedRecipientDomains.length ? `. Allowed domains: ${policy.transferPolicy.allowedRecipientDomains.join(', ')}` : ''}. Max {policy?.transferPolicy.maxRecipientsPerTransfer ?? '—'}.</span>
          </div>
          <div className="field">
            <label htmlFor="title">Title</label>
            <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Q3 board pack" />
            <span className="hint">Shown to recipients only after they verify.</span>
          </div>
          <div className="field">
            <label htmlFor="msg">Message (optional)</label>
            <textarea id="msg" className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} />
          </div>
          <div className="field">
            <label htmlFor="expiry">Available until</label>
            <input id="expiry" className="input" type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} max={maxExpiry ? toLocalInput(maxExpiry.toISOString()) : undefined} required />
            <span className="hint">Policy maximum: {policy?.transferPolicy.maxExpiryHours} hours after sending. Content is deleted at expiry.</span>
          </div>
          <div className="field">
            <label htmlFor="verif">
              Recipient verification {policy?.verification.locked && <span className="lock">set by policy</span>}
            </label>
            <select id="verif" className="select" value={verification} onChange={(e) => setVerification(e.target.value as 'required' | 'bearer')} disabled={policy?.verification.locked}>
              <option value="required">Email code required</option>
              <option value="bearer">None (bearer link)</option>
            </select>
            {verification === 'bearer' && <span className="hint" style={{ color: 'var(--amber)' }}>Anyone who obtains a link can download; recipient identity cannot be verified or audited.</span>}
          </div>
          <div className="field">
            <label htmlFor="limit">
              Download limit per recipient {policy?.transferPolicy.maxDownloadsPerRecipient !== null && policy && <span className="lock">max {policy.transferPolicy.maxDownloadsPerRecipient}</span>}
            </label>
            <input id="limit" className="input" type="number" min={1} max={policy?.transferPolicy.maxDownloadsPerRecipient ?? 1000} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited" />
            <span className="hint">Counts completed or started downloads per file; resuming an interrupted download does not count again.</span>
          </div>
          <fieldset>
            <legend>Notify me by email</legend>
            {policy &&
              Object.keys(policy.notifications.defaults).map((k) => {
                const allowed = policy.notifications.senderChoices[k] ?? true;
                return (
                  <label className="check" key={k}>
                    <input type="checkbox" checked={!!prefs[k]} disabled={!allowed} onChange={(e) => setPrefs((p) => ({ ...p, [k]: e.target.checked }))} />
                    <span>
                      {capitalise(prefLabel(k))}
                      {!allowed && <small>Set by policy</small>}
                    </span>
                  </label>
                );
              })}
            <p className="hint">In-app notifications are always recorded.</p>
          </fieldset>
          <div className="summary" aria-live="polite">{summary() ?? 'Choose an expiry to see the access summary.'}</div>
          {blockers.length > 0 && (
            <ul className="small muted" style={{ paddingLeft: 18 }}>
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          <button className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} disabled={blockers.length > 0 || sending}>
            {sending ? 'Sending…' : `Send to ${emails.length || 'recipients'}${emails.length ? ` recipient${emails.length === 1 ? '' : 's'}` : ''}`}
          </button>
        </aside>
      </div>
    </form>
  );
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function rememberUploadId(transferId: string, file: File, uploadId: string) {
  try {
    localStorage.setItem(`snelson-upload:${transferId}:${file.name}:${file.size}`, uploadId);
  } catch {
    /* ignore */
  }
}
function forgetUploadId(transferId: string, file: File) {
  try {
    localStorage.removeItem(`snelson-upload:${transferId}:${file.name}:${file.size}`);
  } catch {
    /* ignore */
  }
}
export function recallUploadId(transferId: string, file: File): string | null {
  try {
    return localStorage.getItem(`snelson-upload:${transferId}:${file.name}:${file.size}`);
  } catch {
    return null;
  }
}
