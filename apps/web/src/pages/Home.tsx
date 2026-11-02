import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import * as tus from 'tus-js-client';
import { formatBytes, formatDuration, formatRate, type TransferDetail, type TransferFileView, type TransferPolicy, type TransferSummary } from '@snelson/shared';
import { get, post, patch, put, del, errorMessage } from '../api';
import { Picker } from '../components/Picker';
import { fmtLong, toLocalInput, fromLocalInput } from '../lib/time';
import { peopleLabel, refCode } from '../lib/labels';
import { useAuth } from '../auth/AuthContext';
import { RecentSends } from './Sent';

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
  lastTick: { t: number; b: number };
}

const CHUNK = 8 * 1024 * 1024;
const PARALLEL = 2;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
type ExpiryPreset = '1d' | '3d' | '7d' | '14d' | '30d' | 'custom';
type NotifyPreset = 'none' | 'first' | 'every' | 'all';
const EXPIRY_DAYS: Record<Exclude<ExpiryPreset, 'custom'>, number> = { '1d': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30 };

interface Remembered {
  expiry?: ExpiryPreset;
  notify?: NotifyPreset;
}
function remembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem('snelson-compose-prefs') ?? '{}') as Remembered;
  } catch {
    return {};
  }
}
function remember(r: Remembered) {
  try {
    localStorage.setItem('snelson-compose-prefs', JSON.stringify({ ...remembered(), ...r }));
  } catch {
    /* per-viewer convenience only */
  }
}

export function HomePage() {
  const { me } = useAuth();
  const [params] = useSearchParams();
  const existingId = params.get('id');
  const policyQ = useQuery({ queryKey: ['transfer-policy'], queryFn: () => get<PolicyResponse>('/api/transfers/policy') });
  const recentQ = useQuery({ queryKey: ['transfers', 'recent'], queryFn: () => get<{ items: TransferSummary[]; total: number }>('/api/transfers?pageSize=50'), staleTime: 30_000 });
  const policy = policyQ.data;

  const [transfer, setTransfer] = useState<TransferDetail | null>(null);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>(remembered().expiry ?? '7d');
  const [customExpiry, setCustomExpiry] = useState('');
  const [verification, setVerification] = useState<'required' | 'bearer'>('required');
  const [notify, setNotify] = useState<NotifyPreset>(remembered().notify ?? 'first');
  const [extraPrefs, setExtraPrefs] = useState<Record<string, boolean>>({});
  const [limit, setLimit] = useState('');
  const [emails, setEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<TransferDetail | null>(null);
  const [pageOver, setPageOver] = useState(false);
  const transferRef = useRef<TransferDetail | null>(null);
  transferRef.current = transfer;
  const fileInput = useRef<HTMLInputElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const toInput = useRef<HTMLInputElement>(null);

  // ---- expiry as an instant -------------------------------------------------------------------
  const maxHours = policy?.transferPolicy.maxExpiryHours ?? 24 * 30;
  const expiryIso = useMemo(() => {
    if (expiryPreset === 'custom') return customExpiry ? fromLocalInput(customExpiry) : null;
    const hours = Math.min(EXPIRY_DAYS[expiryPreset] * 24, maxHours);
    return new Date(Date.now() + hours * 3_600_000).toISOString();
  }, [expiryPreset, customExpiry, maxHours]);

  // ---- notification prefs from the preset + extras --------------------------------------------
  const prefs = useMemo(() => {
    const base: Record<string, boolean> = { ...(policy?.notifications.defaults ?? {}), ...extraPrefs };
    base.firstVerifiedView = notify === 'all';
    base.firstDownload = notify !== 'none';
    base.everyDownload = notify === 'every' || notify === 'all';
    return base;
  }, [notify, extraPrefs, policy]);

  // ---- initialise from policy / existing draft ------------------------------------------------
  useEffect(() => {
    if (!policy) return;
    if (policy.verification.mode === 'disabled') setVerification('bearer');
    if (!existingId) return;
    get<TransferDetail>(`/api/transfers/${existingId}`)
      .then((t) => {
        if (!['draft', 'uploading', 'scanning', 'ready'].includes(t.status)) return;
        setTransfer(t);
        setTitle(t.title);
        setMessage(t.message);
        setShowNote(!!t.message);
        setExpiryPreset('custom');
        setCustomExpiry(toLocalInput(t.expiresAt));
        setVerification(t.verificationMode);
        setLimit(t.downloadLimitPerRecipient === null ? '' : String(t.downloadLimitPerRecipient));
        setEmails(t.grants.filter((g) => g.status !== 'revoked').map((g) => g.email));
        setUploads(
          t.files.map((f) => ({
            key: f.id,
            file: new File([], f.displayName),
            record: f,
            uploadId: f.uploadStatus === 'finalised' ? null : recallUploadId(t.id, f.displayName, f.sizeBytes),
            upload: null,
            sent: f.uploadedBytes,
            speed: 0,
            status: f.uploadStatus === 'finalised' ? 'done' : f.uploadStatus === 'abandoned' ? 'error' : 'paused',
            error: f.uploadStatus === 'finalised' ? null : 'Choose this file again to resume.',
            lastTick: { t: 0, b: 0 },
          })),
        );
      })
      .catch((e) => setErr(errorMessage(e)));
  }, [policy, existingId]);

  // ---- poll while scanning --------------------------------------------------------------------
  useEffect(() => {
    if (!transfer) return;
    const needs = transfer.files.some((f) => f.scanStatus === 'pending' || f.scanStatus === 'scanning');
    if (!needs) return;
    const id = setInterval(() => {
      get<TransferDetail>(`/api/transfers/${transfer.id}`)
        .then((t) => {
          setTransfer(t);
          setUploads((us) => us.map((u) => ({ ...u, record: t.files.find((f) => f.id === u.record?.id) ?? u.record })));
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(id);
  }, [transfer]);

  const dispatchBody = useCallback(
    () => ({
      title: title.trim() || autoTitle(uploads),
      message,
      expiresAt: expiryIso ?? undefined,
      verificationMode: verification,
      downloadLimitPerRecipient: limit === '' ? null : Number(limit),
      notifyPrefs: prefs,
    }),
    [title, message, expiryIso, verification, limit, prefs, uploads],
  );

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

  const startUpload = useCallback((u: LocalUpload, record: TransferFileView, uploadId: string) => {
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
            if (dt < 1) return { ...x, sent: bytesSent };
            return { ...x, sent: bytesSent, speed: (bytesSent - x.lastTick.b) / dt, lastTick: { t: now, b: bytesSent } };
          }),
        );
      },
      onSuccess: () => {
        update(u.key, () => ({ status: 'done', sent: record.sizeBytes, speed: 0 }));
        announce(`${u.file.name} uploaded. Checking for malware.`);
        get<TransferDetail>(`/api/transfers/${transferRef.current!.id}`)
          .then((t) => {
            setTransfer(t);
            setUploads((us) => us.map((x) => ({ ...x, record: t.files.find((f) => f.id === x.record?.id) ?? x.record })));
          })
          .catch(() => undefined);
      },
      onError: (e) => {
        update(u.key, () => ({ status: 'error', error: e.message.replace(/, request id.*$/, '') }));
        announce(`${u.file.name} interrupted: ${e.message}`);
      },
      onShouldRetry: (e, retryAttempt) => {
        const status = (e as tus.DetailedError).originalResponse?.getStatus() ?? 0;
        if ([401, 403, 404, 409, 413].includes(status)) return false;
        return retryAttempt < 5;
      },
    });
    update(u.key, () => ({ upload, uploadId, record, status: 'uploading', lastTick: { t: Date.now(), b: 0 } }));
    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0]!);
      upload.start();
    });
  }, []);

  useEffect(() => {
    const running = uploads.filter((u) => u.status === 'uploading').length;
    for (const u of uploads.filter((u) => u.status === 'queued').slice(0, Math.max(0, PARALLEL - running))) {
      if (u.record && u.uploadId) startUpload(u, u.record, u.uploadId);
    }
  }, [uploads, startUpload]);

  const addFiles = async (files: FileList | File[]) => {
    setErr(null);
    const list = Array.from(files).filter((f) => f.size > 0 || f.type);
    if (!list.length) return;
    let t: TransferDetail;
    try {
      t = await ensureTransfer();
    } catch (e) {
      setErr(errorMessage(e));
      return;
    }
    for (const file of list) {
      const open = uploads.find((u) => u.record && u.record.uploadStatus !== 'finalised' && u.record.uploadStatus !== 'abandoned' && u.record.displayName === file.name && u.record.sizeBytes === file.size && !u.upload);
      if (open) {
        const id = open.uploadId ?? recallUploadId(t.id, file.name, file.size);
        if (id) {
          setUploads((us) => us.map((u) => (u.key === open.key ? { ...u, file, uploadId: id, status: 'queued', error: null } : u)));
          continue;
        }
      }
      const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 6)}`;
      setUploads((us) => [...us, { key, file, record: null, uploadId: null, upload: null, sent: 0, speed: 0, status: 'registering', error: null, lastTick: { t: 0, b: 0 } }]);
      try {
        const r = await post<{ file: TransferFileView; uploadId: string }>(`/api/transfers/${t.id}/files`, { name: file.name, sizeBytes: file.size, contentType: file.type || 'application/octet-stream' });
        rememberUploadId(t.id, file.name, file.size, r.uploadId);
        setUploads((us) => us.map((u) => (u.key === key ? { ...u, record: r.file, uploadId: r.uploadId, status: 'queued' } : u)));
      } catch (e) {
        setUploads((us) => us.map((u) => (u.key === key ? { ...u, status: 'error', error: errorMessage(e) } : u)));
      }
    }
    get<TransferDetail>(`/api/transfers/${t.id}`).then(setTransfer).catch(() => undefined);
    if (!emails.length) setTimeout(() => toInput.current?.focus(), 50);
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

  // ---- page-level drag and drop ---------------------------------------------------------------
  useEffect(() => {
    if (sent) return;
    let depth = 0;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setPageOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setPageOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      setPageOver(false);
      void addFiles(e.dataTransfer.files);
    };
    document.addEventListener('dragover', over);
    document.addEventListener('dragenter', enter);
    document.addEventListener('dragleave', leave);
    document.addEventListener('drop', drop);
    return () => {
      document.removeEventListener('dragover', over);
      document.removeEventListener('dragenter', enter);
      document.removeEventListener('dragleave', leave);
      document.removeEventListener('drop', drop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent, uploads, transfer]);

  // ---- recipients -----------------------------------------------------------------------------
  const recentEmails = useMemo(() => {
    const seen = new Map<string, number>();
    for (const t of recentQ.data?.items ?? []) for (const r of t.recipients) if (!seen.has(r.email)) seen.set(r.email, seen.size);
    return [...seen.keys()];
  }, [recentQ.data]);
  const suggestions = useMemo(() => {
    const q = emailDraft.trim().toLowerCase();
    if (q.length < 2) return [];
    return recentEmails.filter((e) => e.includes(q) && !emails.includes(e)).slice(0, 5);
  }, [emailDraft, recentEmails, emails]);
  const addEmails = (raw: string) => {
    const parts = raw.split(/[\s,;<>]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
    if (!parts.length) return;
    setEmails((e) => [...new Set([...e, ...parts])]);
    setEmailDraft('');
    setSuggestIdx(0);
  };
  const onEmailKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.length && suggestions[suggestIdx]) {
      e.preventDefault();
      addEmails(suggestions[suggestIdx]!);
      return;
    }
    if (['Enter', ',', ';', ' '].includes(e.key) && emailDraft.trim()) {
      e.preventDefault();
      addEmails(emailDraft);
    } else if (e.key === 'Backspace' && !emailDraft && emails.length) {
      setEmails((x) => x.slice(0, -1));
    } else if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setSuggestIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
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

  // ---- readiness ------------------------------------------------------------------------------
  const totalBytes = uploads.reduce((n, u) => n + (u.record?.sizeBytes ?? u.file.size), 0);
  const sentBytes = uploads.reduce((n, u) => n + (u.status === 'done' ? (u.record?.sizeBytes ?? u.file.size) : u.sent), 0);
  const speed = uploads.filter((u) => u.status === 'uploading').reduce((n, u) => n + u.speed, 0);
  const eta = speed > 0 ? (totalBytes - sentBytes) / speed : NaN;
  const uploading = uploads.some((u) => ['uploading', 'queued', 'registering'].includes(u.status));
  const stuck = uploads.filter((u) => u.status === 'error' || u.status === 'paused');
  const scanning = transfer?.files.some((f) => f.scanStatus === 'pending' || f.scanStatus === 'scanning') ?? false;
  const blockedFiles = (transfer?.files ?? []).filter((f) => f.scanStatus === 'infected' || (f.scanStatus === 'oversized' && !policy?.transferPolicy.allowUnscannedOversizedRelease) || ['error', 'unavailable', 'timeout', 'skipped'].includes(f.scanStatus));
  const allDone = uploads.length > 0 && uploads.every((u) => u.status === 'done');
  const ready = allDone && !scanning && blockedFiles.length === 0;

  let why: string | null = null;
  if (uploads.length === 0) why = 'Add at least one file.';
  else if (uploading) why = speed > 0 && Number.isFinite(eta) ? `Still uploading, about ${formatDuration(eta)} left.` : 'Still uploading.';
  else if (stuck.length) why = `${stuck.length === 1 ? 'One file is' : `${stuck.length} files are`} paused or interrupted. Resume or remove ${stuck.length === 1 ? 'it' : 'them'}.`;
  else if (scanning) why = 'Checking files for malware. This usually takes a few seconds.';
  else if (blockedFiles.length) why = `${blockedFiles.map((f) => f.displayName).join(', ')} cannot be sent. Remove ${blockedFiles.length === 1 ? 'it' : 'them'} to continue.`;
  else if (emails.length === 0) why = 'Add at least one recipient.';
  else if (invalidEmails.length) why = `Check this address: ${invalidEmails.join(', ')}.`;
  else if (domainBlocked.length) why = `Not permitted by policy: ${domainBlocked.join(', ')}.`;
  else if (!expiryIso) why = 'Choose when access should end.';
  else if (new Date(expiryIso).getTime() <= Date.now()) why = 'The expiry must be in the future.';
  else if (new Date(expiryIso).getTime() > Date.now() + maxHours * 3_600_000) why = `Expiry cannot be later than ${fmtLong(new Date(Date.now() + maxHours * 3_600_000))}.`;
  const canSend = why === null && !sending;

  const send = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setErr(null);
    try {
      const t = await ensureTransfer();
      await patch(`/api/transfers/${t.id}`, dispatchBody());
      await put(`/api/transfers/${t.id}/recipients`, { emails });
      const r = await post<TransferDetail>(`/api/transfers/${t.id}/send`, {});
      remember({ expiry: expiryPreset, notify });
      for (const u of uploads) forgetUploadId(t.id, u.file.name, u.file.size);
      setSent(r);
      announce(`Sent to ${emails.join(', ')}.`);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setSending(false);
    }
  }, [canSend, ensureTransfer, dispatchBody, emails, expiryPreset, notify, uploads]);

  // Ctrl/Cmd + Enter sends.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void send();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [send]);

  // Persist the dispatch fields so a refresh keeps them (debounced).
  useEffect(() => {
    if (!transfer || sent) return;
    const id = setTimeout(() => {
      patch<TransferDetail>(`/api/transfers/${transfer.id}`, dispatchBody()).catch(() => undefined);
    }, 800);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, message, expiryIso, verification, limit, prefs]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  // ---- sent ticket ----------------------------------------------------------------------------
  if (sent) {
    const who = sent.grants.map((g) => g.email);
    return (
      <div className="home">
        <section className="ticket" aria-live="polite">
          <h1>Sent to {peopleLabel(who)}</h1>
          <p>
            {who.length === 1 ? <strong>{who[0]}</strong> : who.map((w) => <strong key={w}>{w}</strong>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])} will get an email with a personal link.
            {sent.verificationMode === 'required' ? ' They enter a code we email them before anything is shown.' : ' Anyone with the link can download (no verification).'}
          </p>
          <p>
            {sent.fileCount} file{sent.fileCount === 1 ? '' : 's'}, {formatBytes(sent.totalBytes)} · available until <strong>{fmtLong(sent.expiresAt)}</strong>, then deleted.
          </p>
          <p className="row" style={{ marginTop: 16 }}>
            <Link to={`/sent/${sent.id}`} className="btn btn-primary">Track it</Link>
            <button type="button" className="btn" onClick={() => window.location.assign('/')}>Send more files</button>
            <span className="ref" style={{ marginLeft: 'auto' }}>REF {refCode(sent.id)}</span>
          </p>
        </section>
        <RecentSends />
      </div>
    );
  }

  const hasFiles = uploads.length > 0;
  const expiryOptions = (['1d', '3d', '7d', '14d', '30d'] as const).filter((k) => EXPIRY_DAYS[k] * 24 <= maxHours).map((k) => ({ value: k as ExpiryPreset, label: `${EXPIRY_DAYS[k]} day${EXPIRY_DAYS[k] === 1 ? '' : 's'}` }));
  expiryOptions.push({ value: 'custom', label: 'A specific date and time' });
  const expiryWord = expiryPreset === 'custom' ? (expiryIso ? fmtLong(expiryIso) : 'a date you choose') : `${EXPIRY_DAYS[expiryPreset]} day${EXPIRY_DAYS[expiryPreset] === 1 ? '' : 's'}`;
  const notifyChoices: { value: NotifyPreset; label: string; hint?: string }[] = [
    { value: 'none', label: 'Nothing', hint: 'You can still check progress here.' },
    { value: 'first', label: 'The first download', hint: 'And when each person has everything.' },
    { value: 'every', label: 'Every download' },
    { value: 'all', label: 'Every open and download' },
  ];
  const notifyWord = notifyChoices.find((c) => c.value === notify)!.label.toLowerCase();
  const verifyLocked = !!policy?.verification.locked;
  const summary = expiryIso && emails.length
    ? `Only ${emails.length === 1 ? `1 recipient (${emails[0]})` : `these ${emails.length} recipients`} can download. ${verification === 'required' ? 'Email verification required.' : 'No verification: anyone holding a link can download.'} Available until ${fmtLong(expiryIso)}.`
    : null;

  return (
    <div className={`home ${pageOver ? 'page-drop-over' : ''}`}>
      <div ref={liveRef} className="visually-hidden" aria-live="polite" />
      <input ref={fileInput} type="file" multiple className="visually-hidden" aria-label="Choose files to send" onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
      {err && <div className="notice notice-err" role="alert">{err}</div>}

      {!hasFiles ? (
        <section className={`home-drop ${pageOver ? 'over' : ''}`} aria-labelledby="home-h">
          <h1 id="home-h">Send files securely</h1>
          <p>Drop files anywhere on this page, or</p>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => fileInput.current?.click()}>Choose files</button>
          {policy && (
            <p className="fine">
              Up to {formatBytes(policy.transferPolicy.maxFileBytes, 0)} per file, {formatBytes(policy.transferPolicy.maxTransferBytes, 0)} in total. Every file is checked for malware before it can be sent.
            </p>
          )}
        </section>
      ) : (
        <form className="composer" onSubmit={submit} aria-label="Send files">
          <div className="composer-files">
            <div className="overall">
              <strong>
                {ready && 'Ready to send'}
                {!ready && uploading && 'Uploading'}
                {!ready && !uploading && scanning && 'Checking for malware'}
                {!ready && !uploading && !scanning && stuck.length > 0 && 'Paused'}
                {!ready && !uploading && !scanning && !stuck.length && blockedFiles.length > 0 && 'Cannot send'}
              </strong>
              <span className="small muted num">
                {uploads.length} file{uploads.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
                {uploading && speed > 0 ? ` · ${formatRate(speed)} · about ${formatDuration(eta)} left` : ''}
              </span>
            </div>
            {uploading && (
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 0} aria-label="Overall upload progress">
                <span style={{ width: `${totalBytes ? (sentBytes / totalBytes) * 100 : 0}%` }} />
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              {uploads.map((u) => {
                const size = u.record?.sizeBytes ?? u.file.size;
                const pct = size ? Math.min(100, Math.round(((u.status === 'done' ? size : u.sent) / size) * 100)) : 100;
                const f = u.record;
                let state: { text: string; tone: '' | 'ok' | 'err' | 'warn' } = { text: '', tone: '' };
                if (u.status === 'registering' || u.status === 'queued') state = { text: 'Waiting', tone: '' };
                else if (u.status === 'uploading') state = { text: `${pct}%${u.speed > 0 ? ` · ${formatRate(u.speed)}` : ''}`, tone: '' };
                else if (u.status === 'paused') state = { text: `Paused at ${pct}%`, tone: 'warn' };
                else if (u.status === 'error') state = { text: `Interrupted · ${u.error ?? ''}`, tone: 'err' };
                else if (f) {
                  if (f.scanStatus === 'clean') state = { text: 'Scan passed', tone: 'ok' };
                  else if (f.scanStatus === 'pending' || f.scanStatus === 'scanning') state = { text: 'Checking…', tone: '' };
                  else if (f.scanStatus === 'infected') state = { text: 'Blocked: malware detected', tone: 'err' };
                  else if (f.scanStatus === 'oversized') state = { text: policy?.transferPolicy.allowUnscannedOversizedRelease ? 'Too large to scan (allowed by policy)' : 'Too large to scan', tone: 'warn' };
                  else state = { text: `Scan ${f.scanStatus} · will retry`, tone: 'warn' };
                }
                return (
                  <div className="filerow" key={u.key}>
                    <span className="name">{u.file.name || f?.displayName}</span>
                    <span className={`state ${state.tone}`}>
                      {formatBytes(size)}
                      {state.text ? ` · ${state.text}` : ''}
                    </span>
                    <span className="acts">
                      {u.status === 'uploading' && <button type="button" className="btn btn-sm" onClick={() => pause(u)}>Pause</button>}
                      {(u.status === 'paused' || u.status === 'error') && <button type="button" className="btn btn-sm" onClick={() => resume(u)}>Resume</button>}
                      <button type="button" className="btn btn-sm" onClick={() => void remove(u)} aria-label={`Remove ${u.file.name || f?.displayName}`}>Remove</button>
                    </span>
                    {(u.status === 'uploading' || u.status === 'paused') && (
                      <div className="bar progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${u.file.name} progress`}>
                        <span style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <button type="button" className="addmore" onClick={() => fileInput.current?.click()}>+ Add more files</button>
          </div>

          <div className="composer-line">
            <label htmlFor="recipients">To</label>
            <div style={{ position: 'relative' }}>
              <div className="chips" onClick={() => toInput.current?.focus()}>
                {emails.map((em) => (
                  <span key={em} className={`chip ${!EMAIL_RE.test(em) || domainBlocked.includes(em) ? 'chip-invalid' : ''}`}>
                    {em}
                    <button type="button" aria-label={`Remove ${em}`} onClick={() => setEmails((x) => x.filter((y) => y !== em))}>×</button>
                  </span>
                ))}
                <input
                  ref={toInput}
                  id="recipients"
                  type="text"
                  value={emailDraft}
                  onChange={(e) => { setEmailDraft(e.target.value); setSuggestIdx(0); }}
                  onKeyDown={onEmailKey}
                  onBlur={() => emailDraft.trim() && addEmails(emailDraft)}
                  onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[\s,;]/.test(t.trim())) { e.preventDefault(); addEmails(t); } }}
                  placeholder={emails.length ? 'Add another…' : 'Email addresses, separated by commas'}
                  autoComplete="off"
                  aria-label="Recipients"
                  aria-autocomplete="list"
                  aria-expanded={suggestions.length > 0}
                />
              </div>
              {suggestions.length > 0 && (
                <ul className="suggest" role="listbox" aria-label="Recent recipients">
                  {suggestions.map((s, i) => (
                    <li key={s} role="option" aria-selected={i === suggestIdx}>
                      <button type="button" aria-selected={i === suggestIdx} onMouseDown={(e) => { e.preventDefault(); addEmails(s); }}>{s}</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div className="composer-line">
            <label htmlFor="title">Subject</label>
            <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={autoTitle(uploads)} aria-label="Title" />
          </div>
          {showNote ? (
            <div className="composer-line">
              <label htmlFor="msg">Note</label>
              <textarea id="msg" className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} placeholder="Shown to recipients after they verify." autoFocus />
            </div>
          ) : (
            <div className="composer-line">
              <span className="lbl" aria-hidden="true" />
              <button type="button" className="addmore" style={{ margin: 0 }} onClick={() => setShowNote(true)}>+ Add a note</button>
            </div>
          )}

          <div className="composer-foot">
            <div className="sentence" style={{ margin: 0, width: '100%' }}>
              Available for{' '}
              <Picker<ExpiryPreset>
                ariaLabel="How long the files are available"
                value={expiryPreset}
                options={expiryOptions}
                onChange={(v) => setExpiryPreset(v)}
                custom={
                  expiryPreset === 'custom' ? (
                    <div className="custom">
                      <label htmlFor="custom-exp" className="small">Available until</label>
                      <input id="custom-exp" className="input" type="datetime-local" value={customExpiry} onChange={(e) => setCustomExpiry(e.target.value)} max={toLocalInput(new Date(Date.now() + maxHours * 3_600_000).toISOString())} />
                    </div>
                  ) : (
                    <div className="note">Files are deleted when access ends. Maximum {Math.round(maxHours / 24)} days.</div>
                  )
                }
              >
                {expiryWord}
              </Picker>
              {expiryPreset !== 'custom' && expiryIso && <span className="muted small"> (until {fmtLong(expiryIso)})</span>}
              <span className="dot">·</span>
              <Picker<'required' | 'bearer'>
                ariaLabel="Recipient verification"
                value={verification}
                disabled={verifyLocked}
                lockedHint="Set by your administrator"
                options={[
                  { value: 'required', label: 'Email code required', hint: 'Each recipient proves control of their mailbox before anything is shown.' },
                  { value: 'bearer', label: 'No verification', hint: 'Anyone who gets the link can download. Not recorded as a named person.' },
                ]}
                onChange={setVerification}
              >
                {verification === 'required' ? 'email code required' : 'no verification'}
              </Picker>
              <span className="dot">·</span>
              Tell me about{' '}
              <Picker<NotifyPreset> ariaLabel="Email notifications to you" value={notify} options={notifyChoices} onChange={setNotify}>
                {notifyWord}
              </Picker>
              <details style={{ display: 'inline-block', marginLeft: 10 }}>
                <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>More options</summary>
                <div style={{ margin: '10px 0 4px', display: 'grid', gap: 8, maxWidth: 420 }}>
                  <label className="small" htmlFor="limit">
                    Download limit per recipient{policy?.transferPolicy.maxDownloadsPerRecipient !== null && policy ? ` (max ${policy.transferPolicy.maxDownloadsPerRecipient})` : ''}
                    <input id="limit" className="input" type="number" min={1} max={policy?.transferPolicy.maxDownloadsPerRecipient ?? 1000} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited" style={{ marginTop: 4 }} />
                  </label>
                  {policy &&
                    (['expiringSoon', 'expiredWithoutDownload', 'deletionCompleted'] as const).map((k) => (
                      <label className="check" key={k}>
                        <input type="checkbox" checked={!!prefs[k]} disabled={!(policy.notifications.senderChoices[k] ?? true)} onChange={(e) => setExtraPrefs((p) => ({ ...p, [k]: e.target.checked }))} />
                        <span>Email me when {k === 'expiringSoon' ? 'it is about to expire' : k === 'expiredWithoutDownload' ? 'it expires without a download' : 'the files have been deleted'}</span>
                      </label>
                    ))}
                </div>
              </details>
            </div>
            {summary && <div className="small muted" style={{ margin: 0, width: '100%' }} aria-live="polite">{summary}</div>}
            <span className="why grow" aria-live="polite">{why ?? 'Ctrl + Enter also sends.'}</span>
            <button type="submit" className="btn btn-primary sendbtn" disabled={!canSend}>
              {sending ? 'Sending…' : `Send ${uploads.length === 1 ? '1 file' : `${uploads.length} files`} to ${peopleLabel(emails)}`}
            </button>
          </div>
        </form>
      )}

      {policy && (policy.quota.usedBytes + policy.quota.reservedBytes) / Math.max(1, policy.quota.quotaBytes) > 0.8 && (
        <p className="small muted">You have used {formatBytes(policy.quota.usedBytes + policy.quota.reservedBytes)} of your {formatBytes(policy.quota.quotaBytes, 0)} storage. Space is freed when transfers expire.</p>
      )}
      {me?.user && <RecentSends />}
    </div>
  );
}

function autoTitle(uploads: LocalUpload[]): string {
  if (!uploads.length) return '';
  const first = uploads[0]!.file.name || uploads[0]!.record?.displayName || 'Files';
  if (uploads.length === 1) return first;
  return `${first} and ${uploads.length - 1} more`;
}

function rememberUploadId(transferId: string, name: string, size: number, uploadId: string) {
  try {
    localStorage.setItem(`snelson-upload:${transferId}:${name}:${size}`, uploadId);
  } catch {
    /* ignore */
  }
}
function forgetUploadId(transferId: string, name: string, size: number) {
  try {
    localStorage.removeItem(`snelson-upload:${transferId}:${name}:${size}`);
  } catch {
    /* ignore */
  }
}
function recallUploadId(transferId: string, name: string, size: number): string | null {
  try {
    return localStorage.getItem(`snelson-upload:${transferId}:${name}:${size}`);
  } catch {
    return null;
  }
}
