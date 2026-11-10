import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { fmt } from '../lib/time';
import { eventLabel } from '../lib/events';
import { refCode } from '../lib/labels';
import { useAuth } from '../auth/AuthContext';
import { usePollInterval } from '../lib/live';

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

/** Categories map to the event-type prefixes the audit API filters on. */
const CATEGORIES: [string, string][] = [
  ['', 'Everything'],
  ['transfer.', 'Transfers'],
  ['upload.', 'Uploads'],
  ['scan.', 'Malware scans'],
  ['invitation.', 'Invitations'],
  ['recipient.', 'Recipient verification'],
  ['download.', 'Downloads'],
  ['grant.', 'Access removed'],
  ['deletion.', 'Deletion'],
  ['auth.', 'Sign-in and account security'],
  ['user.', 'User management'],
  ['config.', 'Settings changes'],
  ['admin.', 'Administrator actions'],
  ['audit.', 'Audit exports and retention'],
];

function actorText(e: AuditEvent): string {
  if (e.actorKind === 'system') return 'System';
  if (e.actorKind === 'anonymous') return e.actorEmail ? `Unverified, link for ${e.actorEmail}` : 'Unverified visitor';
  return e.actorEmail ?? e.actorKind;
}

function detailValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function ActivityPage() {
  const { me } = useAuth();
  const [form, setForm] = useState({ from: '', to: '', sender: '', recipient: '', transferId: '', eventType: '' });
  const [applied, setApplied] = useState(form);
  const [page, setPage] = useState(1);
  const poll = usePollInterval(60_000);
  const qs = new URLSearchParams();
  if (applied.from) qs.set('from', new Date(applied.from).toISOString());
  if (applied.to) qs.set('to', new Date(applied.to).toISOString());
  for (const k of ['sender', 'recipient', 'transferId', 'eventType'] as const) if (applied[k]) qs.set(k, applied[k]);
  const q = useQuery({
    queryKey: ['audit', applied, page],
    queryFn: () => get<{ total: number; events: AuditEvent[] }>(`/api/audit?${qs.toString()}&page=${page}&pageSize=50`),
    refetchInterval: page === 1 ? poll : false,
  });
  const apply = (next = form) => {
    setPage(1);
    setApplied(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    apply();
  };
  const clear = () => {
    const empty = { from: '', to: '', sender: '', recipient: '', transferId: '', eventType: '' };
    setForm(empty);
    apply(empty);
  };
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const isSender = me?.user?.role === 'sender';
  const filtered = Object.values(applied).some(Boolean);
  const moreOpen = !!(form.from || form.to || form.sender || form.transferId);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity log</h1>
          <p>{isSender ? 'Everything recorded about your transfers and your account.' : 'Every recorded event you are permitted to see. Records are append-only and chained so tampering shows.'}</p>
        </div>
        <a className="btn" href={`/api/audit/export.csv?${qs.toString()}`}>Export as CSV</a>
      </div>

      <form onSubmit={submit} aria-label="Filter the log">
        <div className="logbar">
          <div className="field">
            <label htmlFor="f-type">Show</label>
            <select
              id="f-type"
              className="select"
              value={form.eventType}
              onChange={(e) => {
                const next = { ...form, eventType: e.target.value };
                setForm(next);
                apply(next);
              }}
            >
              {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-rcpt">Recipient</label>
            <input id="f-rcpt" className="input" type="search" placeholder="Email address" value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} />
          </div>
          <div className="field shrink">
            <button className="btn">Search</button>
          </div>
          {filtered && (
            <div className="field shrink">
              <button type="button" className="btn-link" onClick={clear} style={{ minHeight: 38 }}>Clear filters</button>
            </div>
          )}
        </div>
        <details open={moreOpen || undefined} style={{ marginBottom: 14 }}>
          <summary className="small" style={{ cursor: 'pointer' }}>Dates and more</summary>
          <div className="logbar" style={{ marginTop: 10 }}>
            <div className="field"><label htmlFor="f-from">From</label><input id="f-from" className="input" type="datetime-local" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></div>
            <div className="field"><label htmlFor="f-to">To</label><input id="f-to" className="input" type="datetime-local" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></div>
            {!isSender && <div className="field"><label htmlFor="f-sender">Sender</label><input id="f-sender" className="input" value={form.sender} onChange={(e) => setForm({ ...form, sender: e.target.value })} /></div>}
            <div className="field"><label htmlFor="f-tid">Transfer ID</label><input id="f-tid" className="input mono" value={form.transferId} onChange={(e) => setForm({ ...form, transferId: e.target.value.trim() })} placeholder="Full ID from a transfer's address" /></div>
            <div className="field shrink"><button className="btn">Apply</button></div>
          </div>
        </details>
      </form>

      <p className="small muted" aria-live="polite">
        {q.isLoading ? 'Loading…' : q.isError ? 'The log could not be loaded.' : `${total.toLocaleString('en-GB')} event${total === 1 ? '' : 's'}${filtered ? ' match' : ''}. Select a row for the full record.`}
      </p>

      {q.data && q.data.events.length === 0 ? (
        <div className="empty"><h2>Nothing matches</h2><p>Try a wider date range or a different category.</p></div>
      ) : (
        <div className="log">
          {q.data?.events.map((e) => {
            const bad = e.outcome === 'denied' || e.outcome === 'failure';
            const entries = Object.entries(e.details ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '');
            return (
              <details className="log-row" key={e.id}>
                <summary>
                  <time dateTime={e.occurredAt}>{fmt(e.occurredAt)}</time>
                  <span className="what">{eventLabel(e.eventType)}</span>
                  <span className="actor">{actorText(e)}</span>
                  <span className={`outcome${bad ? ' bad' : ''}`}>{bad ? (e.outcome === 'denied' ? 'Refused' : 'Failed') : e.outcome === 'info' ? 'Noted' : 'OK'}</span>
                </summary>
                <div className="log-detail">
                  <dl>
                    <dt>Record</dt><dd className="mono">#{e.id} · {e.eventType}</dd>
                    {e.transferId && (<><dt>Transfer</dt><dd><Link to={`/sent/${e.transferId}`}>REF {refCode(e.transferId)}</Link> <span className="muted mono small">{e.transferId}</span></dd></>)}
                    {e.ipPrefix && (<><dt>Network</dt><dd className="mono">{e.ipPrefix}</dd></>)}
                    {entries.map(([k, v]) => (
                      <Detail key={k} k={k} v={detailValue(v)} />
                    ))}
                    {e.correlationId && (<><dt>Request</dt><dd className="mono small muted">{e.correlationId}</dd></>)}
                  </dl>
                </div>
              </details>
            );
          })}
        </div>
      )}

      {pages > 1 && (
        <nav className="pager" aria-label="Pagination">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
          <span>Page {page} of {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</button>
        </nav>
      )}
    </>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  const label = k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return (
    <>
      <dt>{label.charAt(0).toUpperCase() + label.slice(1)}</dt>
      <dd>{v.length > 600 ? v.slice(0, 600) + '…' : v}</dd>
    </>
  );
}
