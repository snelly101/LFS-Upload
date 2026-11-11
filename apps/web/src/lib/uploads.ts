import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Tus from 'tus-js-client';

/**
 * Resumable upload engine (tus) shared by pages that take files in. The uploader library is only
 * fetched when the first upload starts. Each file is registered with the server first; the server
 * hands back the upload id that the bytes are then sent against.
 */
export interface UploadItem {
  key: string;
  name: string;
  size: number;
  /** Server-side file id once registered. */
  fileId: string | null;
  uploadId: string | null;
  sent: number;
  speed: number;
  status: 'registering' | 'queued' | 'uploading' | 'paused' | 'done' | 'error';
  error: string | null;
}

interface Internal extends UploadItem {
  file: File;
  tick: { t: number; b: number };
}

export interface UploadOptions {
  /** tus endpoint the bytes are sent to. */
  endpoint: string;
  /** Tell the server about the file; resolves with its id and upload id. */
  register: (file: File) => Promise<{ fileId: string; uploadId: string }>;
  /** Called when a file has been fully received by the server (before scanning). */
  onUploaded?: (item: UploadItem) => void;
  /** Called when registration or the upload fails; return true if the caller has dealt with it. */
  onFailure?: (error: unknown, item: UploadItem) => boolean | void;
  /** Screen-reader announcements. */
  announce?: (message: string) => void;
  parallel?: number;
}

const CHUNK = 8 * 1024 * 1024;

export function useUploads(options: UploadOptions) {
  const opts = useRef(options);
  opts.current = options;
  const [items, setItems] = useState<Internal[]>([]);
  const handles = useRef(new Map<string, Tus.Upload>());
  const patch = useCallback((key: string, p: Partial<Internal> | ((u: Internal) => Partial<Internal>)) => setItems((us) => us.map((u) => (u.key === key ? { ...u, ...(typeof p === 'function' ? p(u) : p) } : u))), []);

  const start = useCallback(
    async (u: Internal) => {
      patch(u.key, { status: 'uploading', error: null, tick: { t: Date.now(), b: u.sent } });
      let tus: typeof Tus;
      try {
        tus = await import('tus-js-client');
      } catch {
        patch(u.key, { status: 'error', error: 'The uploader could not be loaded. Check your connection and try again.' });
        return;
      }
      const upload = new tus.Upload(u.file, {
        endpoint: opts.current.endpoint,
        chunkSize: CHUNK,
        retryDelays: [1000, 3000, 5000, 10000, 20000],
        metadata: { uploadId: u.uploadId!, filename: u.name },
        headers: { 'X-Requested-With': 'securesend' },
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        fingerprint: async () => `securesend:${u.uploadId}`,
        onProgress: (bytesSent) =>
          patch(u.key, (x) => {
            const now = Date.now();
            const dt = (now - x.tick.t) / 1000;
            if (dt < 1) return { sent: bytesSent };
            return { sent: bytesSent, speed: (bytesSent - x.tick.b) / dt, tick: { t: now, b: bytesSent } };
          }),
        onSuccess: () => {
          handles.current.delete(u.key);
          patch(u.key, { status: 'done', sent: u.size, speed: 0 });
          opts.current.announce?.(`${u.name} uploaded. Checking for malware.`);
          opts.current.onUploaded?.({ ...u, status: 'done', sent: u.size });
        },
        onError: (e) => {
          const message = e.message.replace(/, request id.*$/, '').replace(/^tus: /, '');
          const handled = opts.current.onFailure?.(e, u);
          patch(u.key, { status: 'error', speed: 0, error: handled ? 'Interrupted.' : friendly(e as Tus.DetailedError, message) });
          opts.current.announce?.(`${u.name} was interrupted.`);
        },
        onShouldRetry: (e, attempt) => {
          const status = (e as Tus.DetailedError).originalResponse?.getStatus() ?? 0;
          if ([400, 401, 403, 404, 409, 410, 413].includes(status)) return false;
          return attempt < 5;
        },
      });
      handles.current.set(u.key, upload);
      const previous = await upload.findPreviousUploads().catch(() => []);
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]!);
      upload.start();
    },
    [patch],
  );

  // Scheduler: at most `parallel` files in flight.
  useEffect(() => {
    const running = items.filter((u) => u.status === 'uploading').length;
    const room = Math.max(0, (opts.current.parallel ?? 2) - running);
    for (const u of items.filter((x) => x.status === 'queued' && x.uploadId).slice(0, room)) void start(u);
  }, [items, start]);

  /** Register and queue new files. */
  const add = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 7)}`;
        const base: Internal = { key, file, name: file.name, size: file.size, fileId: null, uploadId: null, sent: 0, speed: 0, status: 'registering', error: null, tick: { t: 0, b: 0 } };
        setItems((us) => [...us, base]);
        try {
          const r = await opts.current.register(file);
          patch(key, { fileId: r.fileId, uploadId: r.uploadId, status: 'queued' });
        } catch (e) {
          const handled = opts.current.onFailure?.(e, base);
          if (handled) setItems((us) => us.filter((x) => x.key !== key));
          else patch(key, { status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
      }
    },
    [patch],
  );

  /** Continue an upload the server already knows about (for example after the page was reloaded). */
  const adopt = useCallback((file: File, known: { fileId: string; uploadId: string; sent: number }) => {
    const key = `${file.name}:${file.size}:${known.fileId}`;
    setItems((us) => [...us.filter((x) => x.fileId !== known.fileId), { key, file, name: file.name, size: file.size, fileId: known.fileId, uploadId: known.uploadId, sent: known.sent, speed: 0, status: 'queued', error: null, tick: { t: 0, b: 0 } }]);
  }, []);

  const pause = useCallback(
    (key: string) => {
      void handles.current.get(key)?.abort(false);
      patch(key, { status: 'paused', speed: 0 });
    },
    [patch],
  );
  const resume = useCallback((key: string) => patch(key, (u) => (u.uploadId ? { status: 'queued', error: null } : {})), [patch]);
  /** Stop and tell the server to discard what was sent. */
  const cancel = useCallback(async (key: string) => {
    const h = handles.current.get(key);
    handles.current.delete(key);
    await h?.abort(true).catch(() => undefined);
    setItems((us) => us.filter((x) => x.key !== key));
  }, []);
  /** Forget finished rows once the server's own list shows them. */
  const forget = useCallback((keys: string[]) => setItems((us) => (keys.length ? us.filter((x) => !keys.includes(x.key)) : us)), []);

  useEffect(() => {
    const live = handles.current;
    return () => {
      for (const h of live.values()) void h.abort(false);
    };
  }, []);

  const busy = items.some((u) => u.status === 'registering' || u.status === 'queued' || u.status === 'uploading');
  return { items: items as UploadItem[], add, adopt, pause, resume, cancel, forget, busy };
}

function friendly(e: Tus.DetailedError, fallback: string): string {
  const status = e.originalResponse?.getStatus() ?? 0;
  if (status === 401) return 'Your session has ended. Verify again to continue.';
  if (status === 410) return 'This is no longer accepting files.';
  if (status === 413) return 'This file is larger than the server accepts.';
  if (status === 0) return 'The connection dropped. Resume when you are back online.';
  return fallback.length > 160 ? 'The upload was interrupted. Try again.' : fallback;
}

/** Remember which upload id belongs to a registered file, so a reload can pick the upload back up. */
export const uploadMemory = {
  set(fileId: string, uploadId: string) {
    try {
      localStorage.setItem(`securesend-up:${fileId}`, uploadId);
    } catch {
      /* convenience only */
    }
  },
  get(fileId: string): string | null {
    try {
      return localStorage.getItem(`securesend-up:${fileId}`);
    } catch {
      return null;
    }
  },
  drop(fileId: string) {
    try {
      localStorage.removeItem(`securesend-up:${fileId}`);
    } catch {
      /* convenience only */
    }
  },
};
