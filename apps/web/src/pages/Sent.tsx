import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatBytes, type TransferSummary } from '@snelson/shared';
import { get } from '../api';
import { transferState } from '../components/Status';
import { fmt, countdown } from '../lib/time';

const FILTERS = [
  ['all', 'Everything'],
  ['active', 'Live'],
  ['draft', 'Not sent'],
  ['expired', 'Expired'],
  ['revoked', 'Stopped'],
  ['deleted', 'Deleted'],
] as const;

/** One line per transfer: what, to whom, where it stands. */
function Row({ t }: { t: TransferSummary }) {
  const s = transferState(t);
  const live = s.label === 'Active';
  const unsent = ['draft', 'uploading', 'scanning', 'ready'].includes(t.status);
  const active = t.recipients.filter((r) => r.status !== 'revoked');
  const to = active.length === 0 ? 'No recipients yet' : active.length <= 2 ? active.map((r) => r.email).join(', ') : `${active[0]!.email} and ${active.length - 1} others`;
  let stand = '';
  if (unsent) stand = s.label === 'Ready to send' ? 'Ready to send' : s.label;
  else if (active.length) stand = t.recipientsCompleted === active.length ? 'Everyone has downloaded everything' : t.recipientsCompleted > 0 ? `${t.recipientsCompleted} of ${active.length} downloaded everything` : t.downloadsCompleted > 0 ? 'Downloads in progress' : 'Nothing downloaded yet';
  const tone = s.tone;
  return (
    <Link to={unsent ? `/?id=${t.id}` : `/sent/${t.id}`} className="sent-row">
      <div>
        <div className="t">{t.title || 'Untitled'}</div>
        <div className="to">{to}</div>
      </div>
      <div className="small">
        <span className={`word word-${tone}`}>{s.label}</span>
        <div className="muted">{stand}</div>
      </div>
      <div className="side">
        <strong>{t.fileCount} file{t.fileCount === 1 ? '' : 's'} · {formatBytes(t.totalBytes)}</strong>
        {live ? `until ${fmt(t.expiresAt)} (${countdown(t.expiresAt)})` : t.sentAt ? `sent ${fmt(t.sentAt)}` : `started ${fmt(t.createdAt)}`}
      </div>
    </Link>
  );
}

export function SentPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? 'all';
  const page = Number(params.get('page') ?? '1');
  const [draftQ, setDraftQ] = useState(q);
  const query = useQuery({
    queryKey: ['transfers', q, status, page],
    queryFn: () => get<{ items: TransferSummary[]; total: number }>(`/api/transfers?q=${encodeURIComponent(q)}&status=${status}&page=${page}&pageSize=25`),
    refetchInterval: 15_000,
  });
  const set = (p2: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(p2)) v ? p.set(k, v) : p.delete(k);
    if (!('page' in p2)) p.delete('page');
    setParams(p);
  };
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));
  const search = (e: FormEvent) => {
    e.preventDefault();
    set({ q: draftQ });
  };
  return (
    <>
      <h1 className="lede">Sent</h1>
      <p className="lede-sub">Everything you have sent, and where each one stands.</p>
      <div className="filters">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" className="pill" aria-pressed={status === k} onClick={() => set({ status: k === 'all' ? '' : k })}>{label}</button>
        ))}
        <form onSubmit={search} role="search">
          <label htmlFor="tq" className="visually-hidden">Search by subject or recipient</label>
          <input id="tq" className="input" type="search" placeholder="Search subject or recipient" value={draftQ} onChange={(e) => setDraftQ(e.target.value)} />
          <button className="btn">Search</button>
        </form>
      </div>
      {query.isError && <div className="notice notice-err">Could not load your transfers.</div>}
      {query.data && query.data.items.length === 0 ? (
        <div className="empty">
          <h2>{q || status !== 'all' ? 'Nothing matches' : 'Nothing sent yet'}</h2>
          <p>{q || status !== 'all' ? 'Try a different filter or search.' : 'When you send files, they will be listed here with their progress.'}</p>
          {!q && status === 'all' && <Link to="/" className="btn btn-primary">Send files</Link>}
        </div>
      ) : (
        <div className="sentlist" aria-live="polite" aria-busy={query.isFetching}>
          {query.data?.items.map((t) => <Row key={t.id} t={t} />)}
        </div>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label="Pagination">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
        </nav>
      )}
    </>
  );
}

/** The last few sends, shown under the composer so the home page covers the everyday case. */
export function RecentSends() {
  const q = useQuery({ queryKey: ['transfers', 'recent'], queryFn: () => get<{ items: TransferSummary[]; total: number }>('/api/transfers?pageSize=50'), refetchInterval: 20_000 });
  const items = (q.data?.items ?? []).slice(0, 5);
  if (!items.length) return null;
  return (
    <section aria-labelledby="recent-h">
      <div className="row-between">
        <h2 id="recent-h" className="section-h" style={{ margin: 0 }}>Recent</h2>
        <Link to="/sent" className="small">All sent →</Link>
      </div>
      <div className="sentlist" style={{ marginTop: 8 }}>
        {items.map((t) => <Row key={t.id} t={t} />)}
      </div>
    </section>
  );
}
