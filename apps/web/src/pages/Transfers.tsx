import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { formatBytes, type TransferSummary } from '@snelson/shared';
import { get } from '../api';
import { TransferBadge } from '../components/Status';
import { fmt, countdown } from '../lib/time';
import { eventLabel } from '../lib/events';

const FILTERS = [
  ['all', 'All'],
  ['draft', 'Drafts'],
  ['active', 'Active'],
  ['expired', 'Expired'],
  ['revoked', 'Revoked'],
  ['deleted', 'Deleted'],
] as const;

export function TransfersPage() {
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
  const set = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k);
    if (!('page' in patch)) p.delete('page');
    setParams(p);
  };
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Transfers</h1>
          <p>Your dispatches, their recipients and current access state.</p>
        </div>
        <Link to="/transfers/new" className="btn btn-primary">New transfer</Link>
      </div>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Filter by state">
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => set({ status: k === 'all' ? '' : k })}>
              {label}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: draftQ });
          }}
          className="row"
        >
          <label htmlFor="tq" className="visually-hidden">Search</label>
          <input id="tq" className="input" type="search" placeholder="Title or recipient" value={draftQ} onChange={(e) => setDraftQ(e.target.value)} />
          <button className="btn">Search</button>
        </form>
        <span className="muted small" aria-live="polite">{query.isFetching ? 'Updating…' : `${total} transfer${total === 1 ? '' : 's'}`}</span>
      </div>
      <div className="table-wrap">
        {query.isError && <div className="notice notice-err">Could not load transfers.</div>}
        {query.data && query.data.items.length === 0 ? (
          <div className="empty">
            <h2>{q || status !== 'all' ? 'Nothing matches' : 'No transfers yet'}</h2>
            <p>{q || status !== 'all' ? 'Try a different filter or search term.' : 'Create a transfer to upload files and invite named recipients.'}</p>
            {!q && status === 'all' && <Link to="/transfers/new" className="btn btn-primary">Create your first transfer</Link>}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Recipients</th>
                <th scope="col">Files</th>
                <th scope="col">Size</th>
                <th scope="col">Status</th>
                <th scope="col">Expires</th>
                <th scope="col">Recent activity</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/transfers/${t.id}`} className="row-link">{t.title || 'Untitled transfer'}</Link>
                    <div className="small muted">Created {fmt(t.createdAt)}</div>
                  </td>
                  <td>
                    {t.recipients.length === 0 ? <span className="muted">—</span> : t.recipients.slice(0, 3).map((r) => (
                      <div key={r.email} className="small" style={{ textDecoration: r.status === 'revoked' ? 'line-through' : undefined }}>{r.email}</div>
                    ))}
                    {t.recipients.length > 3 && <div className="small muted">+{t.recipients.length - 3} more</div>}
                    {t.recipients.length > 0 && <div className="small muted">{t.recipientsCompleted}/{t.recipients.length} downloaded all</div>}
                  </td>
                  <td className="num">{t.fileCount}</td>
                  <td className="num">{formatBytes(t.totalBytes)}</td>
                  <td>
                    <TransferBadge t={t} />
                  </td>
                  <td className="num">
                    {fmt(t.expiresAt)}
                    <div className="small muted">{countdown(t.expiresAt)}</div>
                  </td>
                  <td className="small">
                    {t.lastActivityType ? (
                      <>
                        {eventLabel(t.lastActivityType)}
                        <div className="muted">{fmt(t.lastActivityAt)}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {pages > 1 && (
        <nav className="pager" aria-label="Pagination">
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
          <span>
            Page {page} of {pages}
          </span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
        </nav>
      )}
    </>
  );
}
