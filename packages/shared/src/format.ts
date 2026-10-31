const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** Binary units, consistently (1 GiB = 1024 MiB). */
export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ${Math.round(seconds % 60)} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function formatDateTime(iso: string | Date, timeZone = 'Europe/London', locale = 'en-GB'): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

export function formatDateTimeLong(iso: string | Date, timeZone = 'Europe/London', locale = 'en-GB'): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    hour12: false,
  }).format(d);
}

/** Human countdown: "in 3 days", "in 2 h 15 min", "expired". */
export function formatCountdown(toIso: string | Date, now = new Date()): string {
  const to = typeof toIso === 'string' ? new Date(toIso) : toIso;
  const s = Math.round((to.getTime() - now.getTime()) / 1000);
  if (s <= 0) return 'passed';
  const d = Math.floor(s / 86400);
  if (d >= 2) return `in ${d} days`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 1) return `in ${h} h ${m} min`;
  if (m >= 1) return `in ${m} min`;
  return 'in under a minute';
}
