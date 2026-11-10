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
  if (!q.data) return <div className="loading" role="status">{q.isError ? errorMessage(q.error) : 'Loading…'}</div>;
  const h = q.data;
  const pctFree = (h.disk.availableBytes / h.disk.totalBytes) * 100;
  const workerAlive = h.workers.some((w) => w.alive);
  const dead = h.jobs.filter((j) => j.state === 'dead').reduce((n, j) => n + j.n, 0);
  const queued = h.jobs.filter((j) => j.state === 'queued').reduce((n, j) => n + j.n, 0);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-health'] });
  const problems = [!h.scanner.ok, !workerAlive, h.deletion.failed > 0, h.smtp.failed > 0, !h.auditChain.ok, dead > 0].filter(Boolean).length + h.alerts.length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{problems === 0 ? 'Everything is working' : `${problems} thing${problems === 1 ? '' : 's'} need${problems === 1 ? 's' : ''} attention`}</h1>
          <p>Checked {fmt(h.now)} · refreshes every 30 seconds</p>
        </div>
        <span className={`stamp lg ${problems === 0 ? 'stamp-ok' : 'stamp-warn'}`}>{problems === 0 ? 'Healthy' : 'Check'}</span>
      </div>
      {h.alerts.length > 0 && (
        <section aria-labelledby="al-h" style={{ marginBottom: 18 }}>
          <h2 id="al-h" className="section-h" style={{ marginTop: 0 }}>Open alerts</h2>
          {h.alerts.map((a) => (
            <div key={a.id} className={`notice ${a.severity === 'critical' ? 'notice-err' : 'notice-warn'}`} style={{ marginBottom: 8 }}>
              <div className="alert-row">
                <span><strong style={{ display: 'inline' }}>{a.severity === 'critical' ? 'Critical' : 'Warning'}</strong> · {a.message} <span className="muted small">{fmt(a.created_at)}</span></span>
                <button className="btn btn-sm" onClick={() => void post(`/api/admin/alerts/${a.id}/resolve`).then(refresh)}>Mark resolved</button>
              </div>
            </div>
          ))}
        </section>
      )}
      <div className="stat-grid">
        <div className="stat"><span className="label">Storage for files</span><span className="value">{pctFree.toFixed(1)}% free</span><div className="small muted">{formatBytes(h.disk.availableBytes)} free of {formatBytes(h.disk.totalBytes)} · {formatBytes(h.disk.usedByContent)} in transfers · {formatBytes(h.disk.reserved)} reserved for uploads</div></div>
        <div className="stat"><span className="label">Malware scanner</span><span className="value">{h.scanner.ok ? <Badge tone="ok" label="Reachable" /> : <Badge tone="err" label="Unreachable" />}</span><div className="small muted">{h.scanner.version ?? h.scanner.error}</div><div className="small muted">Scans files up to {formatBytes(h.scanner.maxStreamBytes, 0)} · {h.scans.pending} waiting · {h.scans.failed} failed today</div></div>
        <div className="stat"><span className="label">Background worker</span><span className="value">{workerAlive ? <Badge tone="ok" label="Heartbeat OK" /> : <Badge tone="err" label="No heartbeat" />}</span><div className="small muted">{h.workers.map((w) => `${w.id} last seen ${fmt(w.lastSeen)}`).join(' · ') || 'No worker has ever reported in'}</div><div className="small muted">{queued} job{queued === 1 ? '' : 's'} scheduled · {dead} gave up{dead > 0 && <> · <button className="btn-link" onClick={() => void post('/api/admin/jobs/discard-dead').then(refresh)}>discard dead jobs</button></>}</div></div>
        <div className="stat"><span className="label">Deletion</span><span className="value">{h.deletion.failed > 0 ? <Badge tone="err" label={`${h.deletion.failed} failed`} /> : h.deletion.pending > 0 ? <Badge tone="warn" label={`${h.deletion.pending} pending`} /> : <Badge tone="ok" label="No backlog" />}</span><div className="small muted">Oldest overdue: {h.deletion.oldest ? fmt(h.deletion.oldest) : 'none'} · alert after {h.deletion.targetMinutes} min</div><div className="small muted">{h.deletion.completed24h} completed today · typically {h.deletion.avgSeconds !== null ? formatDuration(h.deletion.avgSeconds) : 'not yet measured'}</div></div>
        <div className="stat"><span className="label">Right now</span><span className="value">{h.uploads.active} upload{h.uploads.active === 1 ? '' : 's'} · {h.activeStreams} download{h.activeStreams === 1 ? '' : 's'}</span><div className="small muted">{h.uploads.failed24h} upload{h.uploads.failed24h === 1 ? '' : 's'} abandoned today</div></div>
        <div className="stat"><span className="label">Email</span><span className="value">{h.smtp.failed > 0 ? <Badge tone="err" label={`${h.smtp.failed} failed`} /> : <Badge tone="ok" label="OK" />}</span><div className="small muted">{h.smtp.sent24h} accepted today · {h.smtp.queued} waiting</div>{h.smtp.failed > 0 && <div className="small muted">Failed messages are not retried (their contents are scrubbed after the last attempt); resend from the transfer or the person instead. <button className="btn-link" onClick={() => void post('/api/admin/outbox/discard-failed').then(refresh)}>Discard failed</button></div>}</div>
        <div className="stat"><span className="label">Audit log integrity</span><span className="value">{h.auditChain.ok ? <Badge tone="ok" label="Intact" /> : <Badge tone="err" label={`Broken at #${h.auditChain.brokenAt}`} />}</span><div className="small muted">Last {h.auditChain.checked} records verified. Someone with root on this server could still rewrite the log, so export it regularly.</div></div>
        <div className="stat"><span className="label">Backup last proven</span><span className="value">{h.backup.lastVerifiedAt ? fmt(h.backup.lastVerifiedAt) : <Badge tone="warn" label="Never recorded" />}</span><div className="small muted">{h.backup.note || 'A backup only counts once a restore has been tested.'}</div></div>
      </div>

      <h2 className="section-h">Scheduled work</h2>
      <div className="table-wrap">
        <table className="table"><thead><tr><th scope="col">Job</th><th scope="col">State</th><th scope="col">Count</th><th scope="col">Next or oldest</th></tr></thead><tbody>{h.jobs.map((j) => <tr key={j.kind + j.state}><td>{JOB_LABELS[j.kind] ?? j.kind}<div className="mono small muted">{j.kind}</div></td><td>{j.state === 'dead' ? 'gave up' : j.state === 'queued' ? 'scheduled' : j.state}</td><td className="num">{j.n}</td><td className="small num">{j.oldest ? fmt(j.oldest) : '—'}</td></tr>)}{h.jobs.length === 0 && <tr><td colSpan={4} className="muted">Nothing scheduled.</td></tr>}</tbody></table>
      </div>

      <h2 className="section-h" id="b-h">Record a restore test</h2>
      <div className="card" role="group" aria-labelledby="b-h">
        <p className="small muted">After restoring a database backup somewhere and checking it works, note it here. The date appears above and in the audit log.</p>
        {msg && <div className="notice notice-info" role="status">{msg}</div>}
        <div className="row"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Restored last night's dump to the test server; sign-in and history checked" style={{ maxWidth: 560 }} aria-label="What was tested" /><button className="btn" onClick={() => void withStepUp(() => post('/api/admin/backup-verified', { note })).then(() => { setMsg('Recorded.'); setNote(''); refresh(); }).catch((e) => setMsg(errorMessage(e)))}>Record</button></div>
      </div>
      <p className="small muted">For monitoring tools: <code>/healthz</code> says the service is running, <code>/readyz</code> says it can reach its database.</p>
    </>
  );
}

const JOB_LABELS: Record<string, string> = {
  scan_file: 'Malware scan',
  delete_transfer: 'Delete files at expiry',
  expire_sweep: 'Expiry check',
  reconcile: 'Storage reconciliation',
  deliver_outbox: 'Send email',
  sweep_abandoned_uploads: 'Clear abandoned uploads',
  purge_audit: 'Retention clean-up',
  notify_expiring: 'Expiry reminder',
  disk_check: 'Disk and scanner check',
};
