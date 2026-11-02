import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface PickOption<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

/**
 * A setting written as a word in a sentence. The word is a button; pressing it opens a small
 * list of choices (role=menu with menuitemradio). Arrow keys move, Enter/Space choose, Escape closes.
 */
export function Picker<V extends string>({ value, options, onChange, disabled, lockedHint, children, custom, ariaLabel }: {
  value: V;
  options: PickOption<V>[];
  onChange: (v: V) => void;
  disabled?: boolean;
  lockedHint?: string;
  children: ReactNode; // the word shown in the sentence
  custom?: ReactNode; // optional extra controls at the bottom of the popover
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    const first = root.current?.querySelector<HTMLElement>('[role=menuitemradio][aria-checked=true]') ?? root.current?.querySelector<HTMLElement>('[role=menuitemradio]');
    first?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const move = (dir: 1 | -1, from: HTMLElement) => {
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role=menuitemradio]') ?? []);
    const i = items.indexOf(from);
    items[(i + dir + items.length) % items.length]?.focus();
  };
  return (
    <span className="pick" ref={root}>
      <button ref={btn} type="button" id={id} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} title={disabled ? lockedHint : undefined} onClick={() => setOpen((o) => !o)}>
        {children}
      </button>
      {disabled && lockedHint ? <span className="visually-hidden"> ({lockedHint})</span> : null}
      {open && (
        <div className="pop" role="menu" aria-labelledby={id}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              className="opt"
              tabIndex={-1}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
                btn.current?.focus();
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); move(1, e.currentTarget); }
                if (e.key === 'ArrowUp') { e.preventDefault(); move(-1, e.currentTarget); }
              }}
            >
              <span className="tick" aria-hidden="true">{o.value === value ? '✓' : ''}</span>
              <span>
                {o.label}
                {o.hint && <small>{o.hint}</small>}
              </span>
            </button>
          ))}
          {custom}
        </div>
      )}
    </span>
  );
}
