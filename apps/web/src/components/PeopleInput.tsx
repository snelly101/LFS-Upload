import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { get } from '../api';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email addresses as chips, with suggestions from the people this member of staff has dealt with
 * before (/api/contacts). Suggestions are a convenience: if the endpoint is unavailable the field
 * simply works without them.
 */
export function PeopleInput({ id, value, onChange, invalid = [], ariaLabel, placeholder, inputRef }: {
  id: string;
  value: string[];
  onChange: (emails: string[]) => void;
  /** Addresses to mark as not acceptable (bad format or not permitted by policy). */
  invalid?: string[];
  ariaLabel: string;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [draft, setDraft] = useState('');
  const [idx, setIdx] = useState(0);
  const [hits, setHits] = useState<string[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const own = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    own.current = el;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
  };

  useEffect(() => {
    const q = draft.trim().toLowerCase();
    if (q.length < 2 || unavailable) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      get<{ contacts: { email: string }[] }>(`/api/contacts?q=${encodeURIComponent(q)}`)
        .then((r) => !cancelled && setHits(Array.isArray(r.contacts) ? r.contacts.map((c) => c.email.toLowerCase()) : []))
        .catch(() => !cancelled && setUnavailable(true));
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [draft, unavailable]);

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return q.length < 2 ? [] : hits.filter((e) => e.includes(q) && !value.includes(e)).slice(0, 6);
  }, [draft, hits, value]);

  const add = (raw: string) => {
    const parts = raw.split(/[\s,;<>]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
    if (!parts.length) return;
    onChange([...new Set([...value, ...parts])]);
    setDraft('');
    setIdx(0);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === 'Tab') && suggestions[idx]) {
      e.preventDefault();
      add(suggestions[idx]!);
    } else if (['Enter', ',', ';', ' '].includes(e.key) && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // an empty Enter in this field should not submit a half-filled form
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setIdx((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <div className="chips" onClick={() => own.current?.focus()}>
        {value.map((em) => (
          <span key={em} className={`chip ${!EMAIL_RE.test(em) || invalid.includes(em) ? 'chip-invalid' : ''}`}>
            {em}
            <button type="button" aria-label={`Remove ${em}`} onClick={() => onChange(value.filter((y) => y !== em))}>×</button>
          </span>
        ))}
        <input
          ref={setRefs}
          id={id}
          type="text"
          inputMode="email"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setIdx(0); }}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && add(draft)}
          onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[\s,;]/.test(t.trim())) { e.preventDefault(); add(t); } }}
          placeholder={value.length ? 'Add another…' : placeholder}
          autoComplete="off"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
        />
      </div>
      {suggestions.length > 0 && (
        <ul className="suggest" role="listbox" aria-label="People you have dealt with before">
          {suggestions.map((s, i) => (
            <li key={s} role="option" aria-selected={i === idx}>
              <button type="button" aria-selected={i === idx} onMouseDown={(e) => { e.preventDefault(); add(s); }}>{s}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
