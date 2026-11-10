import { useEffect, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Live updates over Server-Sent Events. While the stream is connected, pages stop their fast polling
 * and refetch only when the server says something changed. If the endpoint is missing or the
 * connection drops, pages fall back to slow polling and we retry with backoff.
 */
let connected = false;
const listeners = new Set<() => void>();
function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLiveConnected(): boolean {
  return useSyncExternalStore(subscribe, () => connected, () => false);
}

/** Polling interval to use for a query: off while live, otherwise the slow fallback. */
export function usePollInterval(fallbackMs = 60_000): number | false {
  return useLiveConnected() ? false : fallbackMs;
}

export function useLiveEvents(qc: QueryClient, enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      es = new EventSource('/api/events', { withCredentials: true });
      es.onopen = () => {
        attempt = 0;
        setConnected(true);
        // Anything that changed while we were disconnected.
        void qc.invalidateQueries({ queryKey: ['transfers'] });
        void qc.invalidateQueries({ queryKey: ['notifications'] });
      };
      es.addEventListener('transfer', (ev) => {
        let id: string | undefined;
        try {
          id = (JSON.parse((ev as MessageEvent).data) as { id?: string }).id;
        } catch {
          /* ignore malformed event */
        }
        void qc.invalidateQueries({ queryKey: ['transfers'] });
        if (id) {
          void qc.invalidateQueries({ queryKey: ['transfer', id] });
          void qc.invalidateQueries({ queryKey: ['transfer-activity', id] });
        }
      });
      es.addEventListener('notification', () => {
        void qc.invalidateQueries({ queryKey: ['notifications'] });
        void qc.invalidateQueries({ queryKey: ['notifications-full'] });
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        if (stopped) return;
        // 2s, 4s, 8s … capped at 2 minutes. A missing endpoint simply keeps the slow polling.
        const delay = Math.min(120_000, 2000 * 2 ** Math.min(attempt, 6));
        attempt++;
        timer = setTimeout(open, delay);
      };
    };
    open();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      es?.close();
      setConnected(false);
    };
  }, [qc, enabled]);
}
