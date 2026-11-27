import type { ReactNode } from 'react';

/**
 * A small set of line icons drawn for this app (24 px grid, round joins). Icons are decoration:
 * they are hidden from assistive technology and every control that uses one also carries text or
 * an aria-label.
 */
const PATHS = {
  upload: (
    <>
      <path d="M7 18.5a4.5 4.5 0 0 1-.7-8.95A6 6 0 0 1 18 9.6a4.45 4.45 0 0 1-.6 8.9" />
      <path d="M12 20v-8" />
      <path d="M8.75 14.75 12 11.5l3.25 3.25" />
    </>
  ),
  send: (
    <>
      <path d="M21 3 3.5 9.6l6.6 3.7 3.7 6.6L21 3z" />
      <path d="M10.2 13.2 21 3" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 13.5h4.6l1.4 2.8h6l1.4-2.8H21" />
      <path d="M5.6 5h12.8L21 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18v-4.5L5.6 5z" />
    </>
  ),
  list: (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7.5h8M17 7.5h3M4 16.5h3M12 16.5h8" />
      <circle cx="14.5" cy="7.5" r="2.2" />
      <circle cx="9.5" cy="16.5" r="2.2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15l1.5-2z" />
      <path d="M10 20.5a2.1 2.1 0 0 0 4 0" />
    </>
  ),
  check: <path d="M5 12.6 9.6 17 19 7.5" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  file: (
    <>
      <path d="M13.5 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V8l-4.5-4.5z" />
      <path d="M13.5 3.5V8H18" />
    </>
  ),
  doc: (
    <>
      <path d="M13.5 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V8l-4.5-4.5z" />
      <path d="M13.5 3.5V8H18M9 12.5h6M9 16h4" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="8.6" cy="9.8" r="1.5" />
      <path d="M4 16.5l4.6-4.3 3.6 3.3 2.8-2.6 5 4.6" />
    </>
  ),
  archive: (
    <>
      <path d="M4.5 8.5h15V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8.5z" />
      <path d="M3.5 4.5h17v4h-17zM10 12.5h4" />
    </>
  ),
  table: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 10h17M3.5 14.5h17M9.5 10v9" />
    </>
  ),
  media: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M10.2 9.2v5.6l4.8-2.8-4.8-2.8z" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5v10.5" />
      <path d="M7.6 11 12 15.4 16.4 11" />
      <path d="M5 19.5h14" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.2 19 6v5.2c0 4.4-2.9 8.3-7 9.6-4.1-1.3-7-5.2-7-9.6V6l7-2.8z" />
      <path d="M8.8 12.2l2.3 2.3 4.2-4.4" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M4 7.5l8 5.8 8-5.8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.3-4.3" />
    </>
  ),
  'chevron-down': <path d="M6.5 9.5 12 15l5.5-5.5" />,
  'chevron-right': <path d="M9.5 6.5 15 12l-5.5 5.5" />,
  'arrow-left': <path d="M19 12H5.5M11 6.5 5.5 12l5.5 5.5" />,
  'arrow-right': <path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.2" fill="currentColor" />
    </>
  ),
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  play: <path d="M8.5 5.8v12.4L18.5 12 8.5 5.8z" />,
  trash: (
    <>
      <path d="M4.5 7h15M9.5 7V4.5h5V7" />
      <path d="M6.5 7l.9 12a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12M10 11v5.5M14 11v5.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.2" r="3.7" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.3" />
      <path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0" />
      <path d="M15.5 5.6a3.3 3.3 0 0 1 0 5.8M17.8 14.2a6.2 6.2 0 0 1 3.4 5.3" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2 3 19.5h18L12 4.2z" />
      <path d="M12 10v4.5M12 17.1v.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.7v.01" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10" />
      <path d="M15 8l4 4-4 4M19 12H9.5" />
    </>
  ),
  activity: <path d="M3.5 12h4l2.5-7 4 14 2.5-7h4" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  heart: <path d="M3.5 12.5h3.5l2-4 3 8 2.5-6 1.5 2h4.5" />,
  storage: (
    <>
      <ellipse cx="12" cy="6.5" rx="7.5" ry="3" />
      <path d="M4.5 6.5v5.5c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6.5M4.5 12v5.5c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V12" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 2-1.9 0-1.3-1-1.7-1-2.9 0-1 .8-1.7 1.9-1.7h2A3.6 3.6 0 0 0 20.5 10.4c0-3.8-3.8-6.9-8.5-6.9z" />
      <path d="M7.8 12h.01M9.8 8h.01M14.2 7.6h.01" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16 7l2.5 2.5M13.5 9.5l2 2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={`icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

const KINDS: [IconName, string, RegExp][] = [
  ['image', 'img', /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/i],
  ['doc', 'doc', /\.(pdf|docx?|odt|rtf|txt|md|pages)$/i],
  ['table', 'sheet', /\.(xlsx?|csv|ods|numbers|tsv)$/i],
  ['archive', 'zip', /\.(zip|7z|rar|tar|gz|tgz|bz2)$/i],
  ['media', 'media', /\.(mp4|mov|avi|mkv|webm|mp3|wav|m4a|flac)$/i],
];

/** A soft tile with an icon chosen from the file's extension. Purely decorative. */
export function FileIcon({ name, state }: { name: string; state?: 'ok' | 'err' | 'warn' | '' }) {
  const hit = KINDS.find(([, , re]) => re.test(name));
  return (
    <span className={`file-ico ${hit ? `k-${hit[1]}` : 'k-file'}${state ? ` is-${state}` : ''}`} aria-hidden="true">
      <Icon name={hit ? hit[0] : 'file'} size={18} />
    </span>
  );
}

/** Initials in a soft circle, coloured from the text so the same person always looks the same. */
export function Avatar({ text, size }: { text: string; size?: 'sm' | 'lg' }) {
  const parts = text.split('@')[0]!.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = (parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : (parts[0] ?? '?').slice(0, 2)).toUpperCase();
  let h = 0;
  for (const c of text.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className={`avatar tinted${size ? ` ${size}` : ''}`} style={{ ['--h' as string]: h }} aria-hidden="true">
      {letters}
    </span>
  );
}
