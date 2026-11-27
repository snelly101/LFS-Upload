import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes, formatRate, type RecipientInboundView } from '@securesend/shared';
import { get, post, ApiError } from '../api';
import { fmtLong, countdown } from '../lib/time';
import { useUploads, uploadMemory, type UploadItem } from '../lib/uploads';
import { Icon, FileIcon, Avatar } from '../components/Icon';

type ServerUpload = RecipientInboundView['uploads'][number];

/**
 * What a verified contributor sees for a file request: who is asking and for what, the real
 * limits, and their own uploads. They can add files but never download anything, so there are no
 * download links here at all.
 */
export default function ContributorPanel({ base, view, onView, onSessionLost, onGone, onSignOut, say }: {
  base: string;
  view: RecipientInboundView;
  onView: (v: RecipientInboundView) => void;
  onSessionLost: () => void;
  onGone: () => void;
  onSignOut: () => void;
  say: (message: string) => void;
}) {
  const [rejected, setRejected] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const lost = useCallback(
    (e: unknown): boolean => {
      const status = e instanceof ApiError ? e.status : ((e as { originalResponse?: { getStatus(): number } | null })?.originalResponse?.getStatus() ?? 0);
      if (status === 401) {
        onSessionLost();
        return true;
      }
      if (status === 410) {
        onGone();
        return true;
      }
      return false;
    },
    [onSessionLost, onGone],
  );
  const refresh = useCallback(
    () =>
      get<RecipientInboundView>(`${base}/view`)
        .then(onView)
        .catch((e) => void lost(e)),
    [base, onView, lost],
  );

  const up = useUploads({
    endpoint: `${base}/tus`,
    register: async (file) => {
      const r = await post<{ file: { id: string }; uploadId: string }>(`${base}/uploads`, { name: file.name, sizeBytes: file.size, contentType: file.type || 'application/octet-stream' });
      uploadMemory.set(r.file.id, r.uploadId);
      void refresh();
      return { fileId: r.file.id, uploadId: r.uploadId };
    },
    onUploaded: (item) => {
      if (item.fileId) uploadMemory.drop(item.fileId);
      void refresh();
    },
    onFailure: lost,
    announce: say,
  });

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Scan results arrive on their own: poll while anything of ours is still being checked.
  const waiting = view.uploads.some((u) => u.state === 'checking') || up.items.some((l) => l.status === 'done' && view.uploads.find((s) => s.id === l.fileId)?.state === 'uploading');
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [waiting, refresh]);

  // Once the server's own list shows a finished file, drop our local copy of the row.
  const { items, forget } = up;
  useEffect(() => {
    const finished = items.filter((l) => l.status === 'done' && l.fileId && ['checking', 'received', 'blocked', 'failed'].includes(view.uploads.find((s) => s.id === l.fileId)?.state ?? '')).map((l) => l.key);
    if (finished.length) forget(finished);
  }, [items, view.uploads, forget]);

  // Announce results to screen readers as they come in.
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    for (const u of view.uploads) {
      const before = seen.current.get(u.id);
      if (before && before !== u.state) {
        if (u.state === 'received') say(`${u.name} received.`);
        if (u.state === 'blocked') say(`${u.name} was blocked by the malware scan and was not delivered.`);
      }
      seen.current.set(u.id, u.state);
    }
  }, [view.uploads, say]);

  const expired = new Date(view.expiresAt).getTime() <= now;
  const limits = view.limits;

  const addFiles = (list: FileList | File[]) => {
    const all = Array.from(list);
    const v = viewRef.current;
    const blocked = new Set(v.limits.blockedExtensions.map((x) => x.toLowerCase()));
    const ext = (f: File) => (f.name.includes('.') ? (f.name.split('.').pop() ?? '').toLowerCase() : '');
    const problems: string[] = [];
    const ok: File[] = [];
    let room = v.limits.remainingFiles;
    let bytes = v.limits.remainingBytes;
    for (const f of all) {
      // A file the server already half-has (page reloaded mid-upload): carry on rather than start again.
      const half = v.uploads.find((s) => s.state === 'uploading' && s.name === f.name && s.sizeBytes === f.size && !up.items.some((l) => l.fileId === s.id));
      const known = half ? uploadMemory.get(half.id) : null;
      if (half && known) {
        up.adopt(f, { fileId: half.id, uploadId: known, sent: half.uploadedBytes });
        continue;
      }
      if (f.size === 0) problems.push(`${f.name} is empty, so there is nothing to send.`);
      else if (f.size > v.limits.maxFileBytes) problems.push(`${f.name} is ${formatBytes(f.size)}. The largest file that can be sent here is ${formatBytes(v.limits.maxFileBytes, 0)}${v.limits.scanLimited ? ', which is the most the malware scanner can check' : ''}.`);
      else if (ext(f) && blocked.has(ext(f))) problems.push(`${f.name} was not added: files of type .${ext(f)} are not accepted.`);
      else if (room <= 0) problems.push(`${f.name} was not added: this request has reached the number of files it can take.`);
      else if (f.size > bytes) problems.push(`${f.name} was not added: there is not enough room left on this request for it.`);
      else {
        ok.push(f);
        room--;
        bytes -= f.size;
      }
    }
    setRejected(problems);
    if (problems.length) say(`${problems.length} file${problems.length === 1 ? ' was' : 's were'} not added.`);
    if (ok.length) void up.add(ok);
  };
  const addRef = useRef(addFiles);
  addRef.current = addFiles;

  // Files can be dropped anywhere on the page.
  useEffect(() => {
    if (expired) return;
    let depth = 0;
    const has = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onOver = (e: DragEvent) => has(e) && e.preventDefault();
    const onEnter = (e: DragEvent) => {
      if (!has(e)) return;
      depth++;
      setOver(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      addRef.current(e.dataTransfer.files);
    };
    document.addEventListener('dragover', onOver);
    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('dragenter', onEnter);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [expired]);

  // One list: the server's record of our files, overlaid with what this page is doing right now.
  const active = (l: UploadItem) => l.status !== 'done';
  const rows: { key: string; name: string; size: number; server?: ServerUpload; local?: UploadItem }[] = [
    ...view.uploads.map((s) => ({ key: s.id, name: s.name, size: s.sizeBytes, server: s, local: up.items.find((l) => l.fileId === s.id) })),
    ...up.items.filter((l) => !l.fileId || !view.uploads.some((s) => s.id === l.fileId)).map((l) => ({ key: l.key, name: l.name, size: l.size, local: l })),
  ];
  const received = view.uploads.filter((u) => u.state === 'received').length;
  const settled = received > 0 && !up.busy && !waiting && !up.items.some((l) => l.status === 'paused' || l.status === 'error');

  return (
    <>
      <div className="rcpt-from">
        <Avatar text={view.requesterName || view.requesterEmail} size="lg" />
        <div style={{ minWidth: 0 }}>
          <div className="name">{view.requesterName}</div>
          <div className="small muted" style={{ overflowWrap: 'anywhere' }}>
            {view.requesterEmail} · asking {view.recipientEmail}
          </div>
        </div>
      </div>
      <h1 style={{ fontSize: '1.3rem' }}>{view.title}</h1>
      {view.message && <p className="rcpt-note">{view.message}</p>}

      {expired ? (
        <div className="notice notice-warn" role="alert"><strong>This request has closed</strong>Files can no longer be sent here. Contact {view.requesterName} if you still need to send something.</div>
      ) : (
        <div className={`rcpt-drop ${over ? 'over' : ''}`}>
          <input ref={input} type="file" multiple className="visually-hidden" aria-label="Choose files to send" tabIndex={-1} onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <button type="button" className="btn btn-primary btn-lg" onClick={() => input.current?.click()}><Icon name="upload" size={20} />Choose files</button>
          <p className="or">or drop them anywhere on this page</p>
          <p className="fine">
            Up to {formatBytes(limits.maxFileBytes, 0)} per file{limits.scanLimited ? ' (the most the malware scanner can check)' : ''}. Uploads carry on where they left off if your connection drops.
          </p>
          {limits.blockedExtensions.length > 0 && (
            <details className="fine">
              <summary>Some file types are not accepted</summary>
              <span className="mono">{limits.blockedExtensions.map((x) => `.${x}`).join(' ')}</span>
            </details>
          )}
        </div>
      )}

      {rejected.length > 0 && (
        <div className="notice notice-warn" role="alert">
          <strong>{rejected.length === 1 ? 'One file was not added' : `${rejected.length} files were not added`}</strong>
          {rejected.map((r) => <div key={r}>{r}</div>)}
          <button type="button" className="btn-link" onClick={() => setRejected([])}>Dismiss</button>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <h2 className="caps" style={{ margin: '20px 0 0' }}>Your files · {received} of {rows.length} received</h2>
          <ul className="rcpt-files rcpt-up" aria-label="Files you have sent">
            {rows.map((r) => {
              const l = r.local && active(r.local) ? r.local : undefined;
              const pct = r.size ? Math.min(100, Math.round(((l ? l.sent : (r.server?.uploadedBytes ?? 0)) / r.size) * 100)) : 0;
              let text = '';
              let tone = '';
              if (l) {
                if (l.status === 'registering' || l.status === 'queued') text = 'Waiting to start';
                else if (l.status === 'uploading') text = `Uploading · ${pct}%${l.speed > 0 ? ` · ${formatRate(l.speed)}` : ''}`;
                else if (l.status === 'paused') [text, tone] = [`Paused at ${pct}%`, 'warn'];
                else [text, tone] = [`Interrupted · ${l.error ?? 'try again'}`, 'err'];
              } else if (r.server) {
                if (r.server.state === 'uploading') [text, tone] = r.local ? ['Finishing…', ''] : [`Interrupted at ${pct}%. Choose the same file again to carry on.`, 'warn'];
                else if (r.server.state === 'checking') text = 'Checking for malware…';
                else if (r.server.state === 'received') [text, tone] = ['Received', 'ok'];
                else if (r.server.state === 'blocked') [text, tone] = ['Blocked: not delivered', 'err'];
                else [text, tone] = ['Could not be checked, so it was not delivered. Try sending it again.', 'warn'];
              }
              return (
                <li key={r.key}>
                  <FileIcon name={r.name} state={tone === 'err' ? 'err' : ''} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="fname">{r.name}</span>
                    <span className="small" style={{ display: 'block' }}>
                      <span className="muted num">{formatBytes(r.size)}</span> · <span className={`fstate ${tone}`}>{text}</span>
                    </span>
                    {l && (l.status === 'uploading' || l.status === 'paused') && (
                      <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${r.name} upload progress`} style={{ display: 'block', marginTop: 6 }}>
                        <span style={{ width: `${pct}%` }} />
                      </span>
                    )}
                  </span>
                  {!l && r.server?.state === 'uploading' && !r.local && (
                    <span className="acts">
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-label={`Remove ${r.name}`}
                        onClick={() => void post(`${base}/uploads/${r.server!.id}/withdraw`, {}).then(refresh).catch(() => undefined)}
                      >
                        Remove
                      </button>
                    </span>
                  )}
                  {l && (
                    <span className="acts">
                      {l.status === 'uploading' && <button type="button" className="btn btn-sm" onClick={() => up.pause(l.key)} aria-label={`Pause ${r.name}`}>Pause</button>}
                      {(l.status === 'paused' || (l.status === 'error' && l.uploadId)) && <button type="button" className="btn btn-sm" onClick={() => up.resume(l.key)} aria-label={`Resume ${r.name}`}>Resume</button>}
                      <button type="button" className="btn btn-sm" onClick={() => void up.cancel(l.key).then(refresh)} aria-label={`Cancel ${r.name}`}>Cancel</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {settled && (
        <div className="notice notice-ok" role="status">
          <strong>{received === 1 ? 'Your file has been received' : `Your ${received} files have been received`}</strong>
          You can close this page; {view.requesterName} has been told. You can also send more until the closing date.
        </div>
      )}

      {!expired && (
        <p className="rcpt-until" style={{ marginTop: 16 }}>
          Open until <strong style={{ display: 'inline' }}>{fmtLong(view.expiresAt)}</strong> ({countdown(view.expiresAt)}). Files are checked for malware, can only be opened by {view.requesterName}, and are deleted on that date.
        </p>
      )}
      <p className="small muted" style={{ marginBottom: 0 }}>
        This page stays open to you until {fmtLong(view.sessionExpiresAt)}; after that you will be asked for a new code.{' '}
        <button className="btn-link" onClick={onSignOut}>Finish and sign out</button>
      </p>
    </>
  );
}
