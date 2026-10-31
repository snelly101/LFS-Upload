import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { fmt } from '../lib/time';
import { eventLabel } from '../lib/events';
import { useAuth } from '../auth/AuthContext';

interface AuditEvent {
  id: number;
  occurredAt: string;
  eventType: string;
  correlationId: string | null;
  actorKind: string;
  actorEmail: string | null;
  transferId: string | null;
  fileId: string | null;
  grantId: string | null;
  outcome: string;
  details: Record<string, unknown>;
  ipPrefix: string | null;
}

export function ActivityPage() {
  const { me } = useAuth();
  const [form, setForm] = useState({ from: '', to: '', sender: '', recipient: '', transferId: '', eventType: '' });
  const [applied, setApplied] = useState(form);
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams();
  if (applied.from) qs.set('from', new Date(applied.from).toISOString());
  if (applied.to) qs.set('to', new Date(applied.to).toISOString());
  for (const k of ['sender', 'recipient', 'transferId', 'eventType'] as const) if (applied[k]) qs.set(k, applied[k]);
  const q = useQuery({ queryKey: ['audit', applied, page], queryFn: () => get<{ total: number; events: AuditEvent[] }>(`/api/audit?${qs.toString()}&page=${page}&pageSize=50`) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setPage(1);
    setApplied(form);
  };
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / 50));
  const isSender = me?.user?.role === 'sender';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>{isSender ? 'Audit events for your transfers and your account.' : 'Audit events in your authorised scope. Records are append-only and hash-chained.'}</p>
        </div>
        <a className="btn" href={`/api/audit/export.csv?${qs.toString()}`}>Export CSV</a>
      </div>
      <form className="card" onSubmit={submit} aria-label="Filters">
        <div className="row">
          <div className="field"><label htmlFor="f-from">From</label><input id="f-from" className="input" type="datetime-local" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></div>
          <div className="field"><label htmlFor="f-to">To</label><input id="f-to" className="input" type="datetime-local" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></div>
          {!isSender && <div className="field"><label htmlFor="f-sender">Sender</label><input id="f-sender" className="input" value={form.sender} onChange={(e) => setForm({ ...form, sender: e.target.value })} /></div>}
          <div className="field"><label htmlFor="f-rcpt">Recipient</label><input id="f-rcpt" className="input" value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} /></div>
          <div className="field"><label htmlFor="f-tid">Transfer ID</label><input id="f-tid" className="input mono" value={form.transferId} onChange={(e) => setForm({ ...form, transferId: e.target.value })} placeholder="uuid" /></div>
          <div className="field"><label htmlFor="f-type">Event type</label><input id="f-type" className="input" value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value })} placeholder="e.g. download." /></div>
          <div className="field"><label aria-hidden="true">&nbsp;</label><button className="btn">Apply</button></div>
        </div>
      </form>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">Outcome</th><th scope="col">Transfer</th><th scope="col">Details</th></tr></thead>
          <tbody>
            {q.data?.events.map((e) => (
              <tr key={e.id}>
                <td className="num small">{fmt(e.occurredAt)}</td>
                <td>{eventLabel(e.eventType)}<div className="small muted mono">{e.eventType}</div></td>
                <td className="small">{e.actorEmail ?? e.actorKind}{e.ipPrefix ? <div className="muted">{e.ipPrefix}</div> : null}</td>
                <td className="small" style={{ color: e.outcome === 'denied' || e.outcome === 'failure' ? 'var(--red)' : undefined }}>{e.outcome}</td>
                <td className="small mono">{e.transferId ? <a href={`/transfers/${e.transferId}`}>{e.transferId.slice(0, 8)}</a> : '—'}</td>
                <td className="small" style={{ maxWidth: 360, overflowWrap: 'anywhere' }}>{summarise(e.details)}</td>
              </tr>
            ))}
            {q.data && q.data.events.length === 0 && <tr><td colSpan={6} className="empty">No events match.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="pager" aria-label="Pagination">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page} of {pages} · {q.data?.total} events</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </nav>
      )}
    </>
  );
}

function summarise(d: Record<string, unknown>): string {
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
    .slice(0, 300);
}
