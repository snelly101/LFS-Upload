import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, formatDuration } from '@securesend/shared';
import { get, post, errorMessage } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { fmt } from '../../lib/time';
import { Badge } from '../../components/Status';

interface Health {
  now: string;
  disk: { totalBytes: number; freeBytes: number; availableBytes: number; usedByContent: number; reserved: number; contentRoot: string };
  scanner: { ok: boolean; version?: string; error?: string; maxStreamBytes: number };
  scans: { pending: number; failed: number };
  uploads: { active: number; failed24h: number };
  deletion: { pending: number; failed: number; oldest: string | null; completed24h: number; avgSeconds: number | null; targetMinutes: number };
  jobs: { kind: string; state: string; n: number; oldest: string | null }[];
  workers: { id: string; lastSeen: string; alive: boolean; details: Record<string, unknown> }[];
  smtp: { failed: number; queued: number; sent24h: number; transport: string };
  activeStreams: number;
  alerts: { id: number; kind: string; severity: string; message: string; created_at: string }[];
  auditChain: { ok: boolean; checked: number; brokenAt?: number };
  backup: { lastVerifiedAt: string | null; note: string };
}

export function HealthPage() {
  const qc = useQueryClient();
  const { withStepUp } = useAuth();
  const q = useQuery({ queryKey: ['admin-health'], queryFn: () => get<Health>('/api/admin/health'), refetchInterval: 30_000 });
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!q.data) return <p>{q.isError ? errorMessage(q.error) : 'Loading…'}</p>;
  const h = q.data;
  const pctFree = (h.disk.availableBytes / h.disk.totalBytes) * 100;
  const workerAlive = h.workers.some((w) => w.alive);
  const dead = h.jobs.filter((j) => j.state === 'dead').reduce((n, j) => n + j.n, 0);
  const queued = h.jobs.filter((j) => j.state === 'queued').reduce((n, j) => n + j.n, 0);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-health'] });
  return (
    <>
      <div className="card-head"><h2>System health</h2><span className="small muted">Server time {fmt(h.now)} · liveness /healthz · readiness /readyz</span></div>
      {h.alerts.length > 0 && (
        <section className="card" aria-labelledby="al-h">
          <h2 id="al-h">Open alerts</h2>
          <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
            {h.alerts.map((a) => (
              <li key={a.id} className={`notice ${a.severity === 'critical' ? 'notice-err' : 'notice-warn'}`} style={{ margin: 0 }}>
                <div className="row-between"><span><strong style={{ display: 'inline' }}>{a.severity}</strong> · {a.message} <span className="muted small">({fmt(a.created_at)})</span></span><button className="btn btn-sm" onClick={() => void post(`/api/admin/alerts/${a.id}/resolve`).then(refresh)}>Mark resolved</button></div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="stat-grid">
        <div className="stat"><span className="label">Content storage</span><span className="value">{pctFree.toFixed(1)}% free</span><div className="small muted">{formatBytes(h.disk.availableBytes)} of {formatBytes(h.disk.totalBytes)} · content {formatBytes(h.disk.usedByContent)} · reserved {formatBytes(h.disk.reserved)}</div><div className="small mono muted">{h.disk.contentRoot}</div></div>
        <div className="stat"><span className="label">Malware scanner</span><span className="value">{h.scanner.ok ? <Badge tone="ok" label="Reachable" /> : <Badge tone="err" label="Unreachable" />}</span><div className="small muted">{h.scanner.version ?? h.scanner.error} · limit {formatBytes(h.scanner.maxStreamBytes, 0)}</div><div className="small muted">{h.scans.pending} awaiting scan · {h.scans.failed} failed (24h)</div></div>
        <div className="stat"><span className="label">Worker</span><span className="value">{workerAlive ? <Badge tone="ok" label="Heartbeat OK" /> : <Badge tone="err" label="No heartbeat" />}</span><div className="small muted">{h.workers.map((w) => `${w.id}: ${fmt(w.lastSeen)}`).join(' · ') || 'no worker has ever reported'}</div><div className="small muted">{queued} queued · {dead} dead jobs</div></div>
        <div className="stat"><span className="label">Deletion</span><span className="value">{h.deletion.failed > 0 ? <Badge tone="err" label={`${h.deletion.failed} failed`} /> : h.deletion.pending > 0 ? <Badge tone="warn" label={`${h.deletion.pending} pending`} /> : <Badge tone="ok" label="No backlog" />}</span><div className="small muted">Oldest overdue: {h.deletion.oldest ? fmt(h.deletion.oldest) : 'none'} · target {h.deletion.targetMinutes} min</div><div className="small muted">{h.deletion.completed24h} completed (24h) · avg {h.deletion.avgSeconds !== null ? formatDuration(h.deletion.avgSeconds) : '—'} (7d)</div></div>
        <div className="stat"><span className="label">Uploads</span><span className="value">{h.uploads.active} active</span><div className="small muted">{h.uploads.failed24h} abandoned (24h) · {h.activeStreams} active download streams</div></div>
        <div className="stat"><span className="label">Email</span><span className="value">{h.smtp.failed > 0 ? <Badge tone="err" label={`${h.smtp.failed} failed`} /> : <Badge tone="ok" label="OK" />}</span><div className="small muted">{h.smtp.queued} queued · {h.smtp.sent24h} accepted (24h) · transport {h.smtp.transport}</div></div>
        <div className="stat"><span className="label">Audit chain</span><span className="value">{h.auditChain.ok ? <Badge tone="ok" label="Intact" /> : <Badge tone="err" label={`Broken at #${h.auditChain.brokenAt}`} />}</span><div className="small muted">{h.auditChain.checked} most recent records verified. A root or database administrator can still rewrite a single-host log; export regularly.</div></div>
        <div className="stat"><span className="label">Backup verification</span><span className="value">{h.backup.lastVerifiedAt ? fmt(h.backup.lastVerifiedAt) : <Badge tone="warn" label="Never recorded" />}</span><div className="small muted">{h.backup.note || 'Record each restore test here.'}</div></div>
      </div>
      <section className="card" style={{ marginTop: 16 }} aria-labelledby="j-h">
        <h2 id="j-h">Job queue</h2>
        <table className="table"><thead><tr><th scope="col">Kind</th><th scope="col">State</th><th scope="col">Count</th><th scope="col">Oldest</th></tr></thead><tbody>{h.jobs.map((j) => <tr key={j.kind + j.state}><td className="mono small">{j.kind}</td><td>{j.state}</td><td className="num">{j.n}</td><td className="small">{j.oldest ? fmt(j.oldest) : '—'}</td></tr>)}{h.jobs.length === 0 && <tr><td colSpan={4} className="muted">Queue is empty.</td></tr>}</tbody></table>
      </section>
      <section className="card" aria-labelledby="b-h">
        <h2 id="b-h">Record a backup/restore verification</h2>
        {msg && <div className="notice notice-info" role="status">{msg}</div>}
        <div className="row"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Restored DB dump to staging; metadata only, content excluded by design" style={{ maxWidth: 520 }} aria-label="Verification note" /><button className="btn" onClick={() => void withStepUp(() => post('/api/admin/backup-verified', { note })).then(() => { setMsg('Recorded.'); refresh(); }).catch((e) => setMsg(errorMessage(e)))}>Record</button></div>
      </section>
    </>
  );
}
