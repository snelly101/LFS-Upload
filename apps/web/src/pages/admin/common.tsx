import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AllSettings } from '@snelson/shared';
import { get, put, errorMessage } from '../../api';
import { useAuth } from '../../auth/AuthContext';

export interface SettingsResponse {
  settings: AllSettings;
  policyVersionId: number | null;
  scannerMaxBytes: number;
}

export function useSettings() {
  return useQuery({ queryKey: ['admin-settings'], queryFn: () => get<SettingsResponse>('/api/admin/settings') });
}

export function AdminLayout() {
  return (
    <>
      <div className="page-head"><div><h1>Administration</h1><p>Settings are versioned and audited. Security-sensitive changes need a reason and a recent re-authentication.</p></div></div>
      <div className="admin-layout">
        <nav className="subnav" aria-label="Settings sections">
          <NavLink to="/admin" end>Branding</NavLink>
          <NavLink to="/admin/identity">Identity &amp; access</NavLink>
          <NavLink to="/admin/transfer-policy">Transfer policy</NavLink>
          <NavLink to="/admin/verification">Recipient verification</NavLink>
          <NavLink to="/admin/notifications">Notifications</NavLink>
          <NavLink to="/admin/storage">Storage &amp; deletion</NavLink>
          <NavLink to="/admin/audit">Audit &amp; privacy</NavLink>
          <NavLink to="/admin/health">System health</NavLink>
          <NavLink to="/admin/users">Users</NavLink>
        </nav>
        <div><Outlet /></div>
      </div>
    </>
  );
}

/** Generic section form: edits a draft copy, saves with reason (+ optional secrets), handles step-up. */
export function SectionForm<K extends keyof AllSettings>({ section, title, intro, sensitive, render, secretsRender, impact }: {
  section: K;
  title: string;
  intro?: ReactNode;
  sensitive?: boolean;
  impact?: ReactNode;
  render: (draft: AllSettings[K], set: (patch: Partial<AllSettings[K]>) => void) => ReactNode;
  secretsRender?: (secrets: Record<string, string>, set: (k: string, v: string) => void) => ReactNode;
}) {
  const q = useSettings();
  const qc = useQueryClient();
  const { withStepUp } = useAuth();
  const [draft, setDraft] = useState<AllSettings[K] | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !draft) setDraft(structuredClone(q.data.settings[section]));
  }, [q.data, draft, section]);
  if (!draft) return <p>Loading…</p>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await withStepUp(() => put(`/api/admin/settings/${section}`, { value: draft, reason, secrets: Object.keys(secrets).length ? secrets : undefined }));
      setMsg({ tone: 'ok', text: 'Saved.' });
      setSecrets({});
      setReason('');
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
      await qc.invalidateQueries({ queryKey: ['auth-options'] });
      setDraft(null);
    } catch (x) {
      setMsg({ tone: 'err', text: errorMessage(x) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={save} aria-labelledby={`sec-${section}`}>
      <h2 id={`sec-${section}`}>{title}</h2>
      {intro && <div className="small muted" style={{ marginBottom: 12 }}>{intro}</div>}
      {msg && <div className={`notice notice-${msg.tone}`} role={msg.tone === 'err' ? 'alert' : 'status'}>{msg.text}</div>}
      {render(draft, (patch) => setDraft({ ...draft, ...patch }))}
      {secretsRender?.(secrets, (k, v) => setSecrets({ ...secrets, [k]: v }))}
      {impact && <div className="notice notice-info">{impact}</div>}
      <div className="field">
        <label htmlFor={`reason-${section}`}>Reason for change {sensitive ? '(required, audited)' : '(optional, audited)'}</label>
        <input id={`reason-${section}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} required={sensitive} maxLength={500} />
      </div>
      <div className="row">
        <button className="btn btn-primary" disabled={busy}>Save {title.toLowerCase()}</button>
        <button type="button" className="btn" onClick={() => setDraft(null)}>Discard changes</button>
        {q.data?.policyVersionId !== null && <span className="small muted">Policy version {q.data?.policyVersionId}</span>}
      </div>
    </form>
  );
}

export function NumField({ id, label, value, onChange, hint, min, max, step }: { id: string; label: string; value: number; onChange: (n: number) => void; hint?: string; min?: number; max?: number; step?: number }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} style={{ maxWidth: 240 }} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
export function GiBField({ id, label, value, onChange, hint }: { id: string; label: string; value: number; onChange: (n: number) => void; hint?: string }) {
  const GiB = 1024 ** 3;
  return (
    <div className="field">
      <label htmlFor={id}>{label} (GiB)</label>
      <input id={id} className="input" type="number" step="0.5" min={0} value={Math.round((value / GiB) * 100) / 100} onChange={(e) => onChange(Math.round(Number(e.target.value) * GiB))} style={{ maxWidth: 240 }} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
export function TextField({ id, label, value, onChange, hint, type = 'text', placeholder }: { id: string; label: string; value: string; onChange: (s: string) => void; hint?: string; type?: string; placeholder?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
export function ListField({ id, label, value, onChange, hint }: { id: string; label: string; value: string[]; onChange: (s: string[]) => void; hint?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} className="textarea" value={value.join('\n')} onChange={(e) => onChange(e.target.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))} style={{ minHeight: 60 }} />
      {hint && <span className="hint">{hint} One per line.</span>}
    </div>
  );
}
export function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (b: boolean) => void; hint?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}
