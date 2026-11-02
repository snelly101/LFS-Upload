import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put, errorMessage } from '../api';
import { fmt } from '../lib/time';
import { useAuth } from '../auth/AuthContext';
import { prefLabel } from '../lib/labels';

interface Item {
  id: number;
  kind: string;
  title: string;
  body: string;
  transferId: string | null;
  createdAt: string;
  readAt: string | null;
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const { me, refresh } = useAuth();
  const q = useQuery({ queryKey: ['notifications-full'], queryFn: () => get<{ unread: number; items: Item[] }>('/api/notifications') });
  const policy = useQuery({ queryKey: ['transfer-policy'], queryFn: () => get<{ notifications: { senderChoices: Record<string, boolean>; defaults: Record<string, boolean> } }>('/api/transfers/policy'), enabled: me?.user?.role !== 'auditor' });
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (me?.user && policy.data) setPrefs({ ...policy.data.notifications.defaults, ...me.user.notificationPrefs });
  }, [me, policy.data]);
  const markAll = useMutation({
    mutationFn: () => post('/api/notifications/read', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications-full'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  const save = useMutation({
    mutationFn: () => put('/api/notifications/preferences', prefs),
    onSuccess: async () => {
      setMsg('Preferences saved. They apply to new transfers.');
      await refresh();
    },
    onError: (e) => setMsg(errorMessage(e)),
  });
  return (
    <>
      <div className="page-head">
        <div><h1>Notifications</h1><p>In-app notices and your default email preferences.</p></div>
        <button className="btn" onClick={() => markAll.mutate()} disabled={!q.data?.unread}>Mark all as read</button>
      </div>
      <div className="two-col">
        <section className="card" aria-labelledby="n-h">
          <h2 id="n-h">Recent</h2>
          {q.data?.items.length === 0 && <p className="muted">Nothing yet. Activity on your transfers will appear here.</p>}
          <ul className="receipt">
            {q.data?.items.map((n) => (
              <li key={n.id} style={{ fontWeight: n.readAt ? 400 : 600 }}>
                <time dateTime={n.createdAt}>{fmt(n.createdAt)}</time>
                <div>
                  {n.title}
                  {n.body && <div className="who">{n.body}</div>}
                  {n.transferId && <div className="small"><Link to={`/sent/${n.transferId}`}>Open transfer</Link></div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
        {policy.data && (
          <aside className="card" aria-labelledby="p-h">
            <h2 id="p-h">Email defaults for new transfers</h2>
            {msg && <div className="notice notice-info" role="status">{msg}</div>}
            {Object.keys(policy.data.notifications.defaults).map((k) => {
              const allowed = policy.data!.notifications.senderChoices[k] ?? true;
              return (
                <label className="check" key={k}>
                  <input type="checkbox" checked={!!prefs[k]} disabled={!allowed} onChange={(e) => setPrefs((p) => ({ ...p, [k]: e.target.checked }))} />
                  <span>{prefLabel(k).charAt(0).toUpperCase() + prefLabel(k).slice(1)}{!allowed && <small>Fixed by organisation policy</small>}</span>
                </label>
              );
            })}
            <p className="hint">Security notices about your account are always sent. "Every download" emails are de-duplicated per recipient and file.</p>
            <button className="btn btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>Save preferences</button>
          </aside>
        )}
      </div>
    </>
  );
}
