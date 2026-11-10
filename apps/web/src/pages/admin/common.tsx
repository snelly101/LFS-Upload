import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AllSettings } from '@securesend/shared';
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

/**
 * One settings page. Edits a draft; a save bar appears only when something has changed. Sections the
 * server treats as security-sensitive ask why (the reason is written to the audit log) and may ask
 * for a fresh second-factor check.
 */
export function SectionForm<K extends keyof AllSettings>({ section, title, intro, sensitive, render, secretsRender, impact, saveLabel }: {
  section: K;
  title: string;
  intro?: ReactNode;
  sensitive?: boolean;
  impact?: ReactNode;
  saveLabel?: string;
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
  const saved = q.data?.settings[section];
  const [base, setBase] = useState<AllSettings[K] | null>(null);
  useEffect(() => {
    if (!saved) return;
    if (!draft || !base) {
      setDraft(structuredClone(saved));
      setBase(saved);
    } else if (base !== saved && JSON.stringify(base) !== JSON.stringify(saved)) {
      // The section was saved elsewhere (another card on this page edits the same section):
      // keep only the fields changed here and take everything else from the newly saved value.
      setDraft(rebase(saved, base, draft));
      setBase(saved);
    }
  }, [saved, draft, base]);
  const dirty = useMemo(() => !!draft && !!saved && (JSON.stringify(draft) !== JSON.stringify(saved) || Object.values(secrets).some(Boolean)), [draft, saved, secrets]);
  if (!draft) return <div className="loading" role="status">{q.isError ? errorMessage(q.error) : 'Loading…'}</div>;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const sent = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v));
      await withStepUp(() => put(`/api/admin/settings/${section}`, { value: draft, reason, secrets: Object.keys(sent).length ? sent : undefined }));
      setMsg({ tone: 'ok', text: 'Saved.' });
      setSecrets({});
      setReason('');
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
      await qc.invalidateQueries({ queryKey: ['auth-options'] });
      await qc.invalidateQueries({ queryKey: ['transfer-policy'] });
      setDraft(null);
    } catch (x) {
      setMsg({ tone: 'err', text: errorMessage(x) });
    } finally {
      setBusy(false);
    }
  };
  const discard = () => {
    setDraft(null);
    setSecrets({});
    setReason('');
    setMsg(null);
  };
  return (
    <form className="card settings" onSubmit={save} aria-labelledby={`sec-${section}`}>
      <h2 id={`sec-${section}`}>{title}</h2>
      {intro && <p className="intro">{intro}</p>}
      {render(draft, (patch) => { setMsg(null); setDraft({ ...draft, ...patch }); })}
      {secretsRender?.(secrets, (k, v) => setSecrets({ ...secrets, [k]: v }))}
      {impact && <div className="notice notice-info" style={{ marginTop: 18 }}><strong>What changing this does</strong>{impact}</div>}
      {msg && <div className={`notice notice-${msg.tone}`} role={msg.tone === 'err' ? 'alert' : 'status'} style={{ marginTop: 14 }}>{msg.text}</div>}
      {dirty && (
        <div className="savebar" role="region" aria-label="Unsaved changes">
          {sensitive ? (
            <div className="field">
              <label htmlFor={`reason-${section}`}>Why are you changing this? <span className="muted" style={{ fontWeight: 400 }}>Kept in the audit log.</span></label>
              <input id={`reason-${section}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} placeholder="e.g. Agreed at the October security review" />
            </div>
          ) : (
            <span className="grow"><strong>You have unsaved changes</strong></span>
          )}
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : saveLabel ?? 'Save changes'}</button>
          <button type="button" className="btn" onClick={discard}>Discard</button>
        </div>
      )}
    </form>
  );
}

/** Re-apply local edits (draft vs base) on top of a newer saved value, one level deep. */
function rebase<T>(saved: T, base: T, draft: T): T {
  const out: Record<string, unknown> = { ...(saved as Record<string, unknown>) };
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  for (const k of Object.keys(draft as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    const d = (draft as Record<string, unknown>)[k];
    const s = (saved as Record<string, unknown>)[k];
    if (JSON.stringify(b) === JSON.stringify(d)) continue;
    if (isObj(b) && isObj(d) && isObj(s)) {
      const merged: Record<string, unknown> = { ...s };
      for (const kk of Object.keys(d)) if (JSON.stringify(b[kk]) !== JSON.stringify(d[kk])) merged[kk] = d[kk];
      out[k] = merged;
    } else {
      out[k] = d;
    }
  }
  return out as T;
}

export function Group({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <fieldset>
      <legend>{title}</legend>
      {note && <p className="group-note">{note}</p>}
      {children}
    </fieldset>
  );
}

export function NumField({ id, label, value, onChange, hint, min, max, step, suffix }: { id: string; label: string; value: number; onChange: (n: number) => void; hint?: ReactNode; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="unit-field">
        <input id={id} className="input" type="number" value={Number.isFinite(value) ? value : ''} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} aria-describedby={hint ? `${id}-h` : undefined} />
        {suffix && <span className="muted" style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>{suffix}</span>}
      </div>
      {hint && <span className="hint" id={`${id}-h`}>{hint}</span>}
    </div>
  );
}

type TimeUnit = 'seconds' | 'minutes' | 'hours' | 'days';
const SECONDS: Record<TimeUnit, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

/** A length of time shown in whichever unit reads best; stored in the unit the server expects. */
export function DurationField({ id, label, value, onChange, stored, units, hint, min, max }: { id: string; label: string; value: number; onChange: (n: number) => void; stored: TimeUnit; units: TimeUnit[]; hint?: ReactNode; min?: number; max?: number }) {
  const secs = value * SECONDS[stored];
  const best = [...units].reverse().find((u) => secs >= SECONDS[u] && secs % SECONDS[u] === 0) ?? units[0]!;
  const [unit, setUnit] = useState<TimeUnit>(best);
  const shown = Math.round((secs / SECONDS[unit]) * 100) / 100;
  const toStored = (n: number, u: TimeUnit) => Math.max(1, Math.round((n * SECONDS[u]) / SECONDS[stored]));
  const outOfRange = (min !== undefined && value < min) || (max !== undefined && value > max);
  const fmtBound = (n: number) => {
    const s = n * SECONDS[stored];
    const u = [...units].reverse().find((x) => s % SECONDS[x] === 0 && s >= SECONDS[x]) ?? stored;
    const v = s / SECONDS[u];
    return `${v} ${v === 1 ? u.slice(0, -1) : u}`;
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="unit-field">
        <input id={id} className="input" type="number" min={0} step="any" value={shown} aria-invalid={outOfRange || undefined} aria-describedby={`${id}-h`} onChange={(e) => onChange(toStored(Number(e.target.value), unit))} />
        <select className="select" aria-label={`${label}: unit`} value={unit} onChange={(e) => setUnit(e.target.value as TimeUnit)}>
          {units.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      <span className="hint" id={`${id}-h`}>
        {hint}
        {min !== undefined && max !== undefined && <>{hint ? ' ' : ''}Between {fmtBound(min)} and {fmtBound(max)}.</>}
      </span>
    </div>
  );
}

type SizeUnit = 'MiB' | 'GiB' | 'TiB';
const BYTES: Record<SizeUnit, number> = { MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };

/** A size in bytes shown as MiB/GiB/TiB. `zeroMeans` labels the special value 0 (e.g. "no limit"). */
export function SizeField({ id, label, value, onChange, hint, zeroMeans }: { id: string; label: string; value: number; onChange: (n: number) => void; hint?: ReactNode; zeroMeans?: string }) {
  const best: SizeUnit = value >= BYTES.TiB && value % BYTES.TiB === 0 ? 'TiB' : value >= BYTES.GiB ? 'GiB' : value === 0 ? 'GiB' : 'MiB';
  const [unit, setUnit] = useState<SizeUnit>(best);
  const shown = Math.round((value / BYTES[unit]) * 100) / 100;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="unit-field">
        <input id={id} className="input" type="number" min={0} step="any" value={shown} aria-describedby={`${id}-h`} onChange={(e) => onChange(Math.max(0, Math.round(Number(e.target.value) * BYTES[unit])))} />
        <select className="select" aria-label={`${label}: unit`} value={unit} onChange={(e) => setUnit(e.target.value as SizeUnit)}>
          {(Object.keys(BYTES) as SizeUnit[]).map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </div>
      <span className="hint" id={`${id}-h`}>
        {zeroMeans && value === 0 ? <strong>{zeroMeans}. </strong> : null}
        {hint}
        {zeroMeans && value !== 0 ? <> Enter 0 for {zeroMeans.toLowerCase()}.</> : null}
      </span>
    </div>
  );
}

export function TextField({ id, label, value, onChange, hint, type = 'text', placeholder, mono }: { id: string; label: string; value: string; onChange: (s: string) => void; hint?: ReactNode; type?: string; placeholder?: string; mono?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className={`input${mono ? ' mono' : ''}`} type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-h` : undefined} spellCheck={mono ? false : undefined} />
      {hint && <span className="hint" id={`${id}-h`}>{hint}</span>}
    </div>
  );
}

/** A list edited one item per line. `emptyMeans` says what an empty list does. */
export function ListField({ id, label, value, onChange, hint, emptyMeans, mono, normalise }: { id: string; label: string; value: string[]; onChange: (s: string[]) => void; hint?: ReactNode; emptyMeans?: string; mono?: boolean; normalise?: (s: string) => string }) {
  const [text, setText] = useState(value.join('\n'));
  const key = value.join('\n');
  useEffect(() => {
    // Re-sync when the saved value changes underneath us (after save or discard).
    setText((t) => (parse(t, normalise).join('\n') === key ? t : key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} className={`textarea${mono ? ' mono' : ''}`} value={text} rows={Math.min(8, Math.max(2, value.length + 1))} spellCheck={false} aria-describedby={`${id}-h`} onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value, normalise)); }} />
      <span className="hint" id={`${id}-h`}>
        One per line. {value.length === 0 && emptyMeans ? <strong>{emptyMeans} </strong> : null}
        {hint}
      </span>
    </div>
  );
}
function parse(text: string, normalise?: (s: string) => string): string[] {
  return text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((s) => (normalise ? normalise(s) : s));
}

export function Check({ label, checked, onChange, hint, disabled }: { label: string; checked: boolean; onChange: (b: boolean) => void; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );
}

/** A small set of mutually exclusive choices, each with its consequence spelled out. */
export function Choice<V extends string>({ legend, value, onChange, options }: { legend: string; value: V; onChange: (v: V) => void; options: { value: V; label: string; hint?: ReactNode }[] }) {
  const name = useId();
  return (
    <div className="field" role="radiogroup" aria-label={legend}>
      <span className="label">{legend}</span>
      {options.map((o) => (
        <label className="check" key={o.value}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label}{o.hint && <small>{o.hint}</small>}</span>
        </label>
      ))}
    </div>
  );
}

export function Segmented<V extends string>({ legend, value, onChange, options }: { legend: string; value: V; onChange: (v: V) => void; options: { value: V; label: string }[] }) {
  const name = useId();
  return (
    <div className="field">
      <span className="label" id={`${name}-l`}>{legend}</span>
      <div className="seg" role="radiogroup" aria-labelledby={`${name}-l`}>
        {options.map((o) => (
          <label key={o.value}>
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </div>
  );
}
