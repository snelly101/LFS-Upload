import { formatDateTime, formatDateTimeLong, formatCountdown } from '@snelson/shared';

let currentTz = 'Europe/London';
export function setTimeZone(tz: string) {
  currentTz = tz || 'Europe/London';
}
export function fmt(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return formatDateTime(iso, currentTz);
}
export function fmtLong(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return formatDateTimeLong(iso, currentTz);
}
export function countdown(iso: string | Date): string {
  return formatCountdown(iso);
}
export function tz() {
  return currentTz;
}
/** Convert ISO (UTC) to a value for <input type="datetime-local"> in the display time zone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: currentTz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}
/** Interpret a datetime-local value in the display time zone and return an ISO UTC string. */
export function fromLocalInput(v: string): string {
  const [date, time] = v.split('T');
  const [y, m, d] = date!.split('-').map(Number);
  const [hh, mm] = (time ?? '00:00').split(':').map(Number);
  // iterate: find UTC instant whose representation in tz matches
  let guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: currentTz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(guess));
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') === 24 ? 0 : g('hour'), g('minute'));
    const diff = asUtc - guess;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess).toISOString();
}
