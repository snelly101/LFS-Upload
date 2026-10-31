import type { ActivityEvent } from '@snelson/shared';
import { fmt } from '../lib/time';
import { eventLabel } from '../lib/events';

function who(e: ActivityEvent): string {
  if (e.actorKind === 'system') return 'system';
  if (e.actorKind === 'anonymous') return e.actorEmail ? `link for ${e.actorEmail} (unverified)` : 'unverified link holder';
  return e.actorEmail ?? e.actorKind;
}

function detail(e: ActivityEvent): string | null {
  const d = e.details ?? {};
  const bits: string[] = [];
  if (typeof d.fileName === 'string') bits.push(d.fileName);
  if (typeof d.email === 'string') bits.push(d.email);
  if (typeof d.reason === 'string' && d.reason) bits.push(`reason: ${d.reason}`);
  if (typeof d.status === 'string') bits.push(d.status);
  if (typeof d.detail === 'string') bits.push(d.detail);
  if (typeof d.to === 'string' && typeof d.from === 'string') bits.push(`${fmt(d.from)} → ${fmt(d.to)}`);
  if (typeof d.bytesServed === 'number' && typeof d.of === 'number') bits.push(`${d.bytesServed} of ${d.of} bytes`);
  if (typeof d.note === 'string') bits.push(d.note);
  return bits.length ? bits.join(' · ') : null;
}

export function Receipt({ events, fileNames }: { events: ActivityEvent[]; fileNames?: Record<string, string> }) {
  if (!events.length) return <p className="muted small">No activity recorded yet.</p>;
  return (
    <ol className="receipt" aria-label="Activity receipt">
      {events.map((e) => (
        <li key={e.id}>
          <time dateTime={e.occurredAt}>{fmt(e.occurredAt)}</time>
          <div>
            <span className={e.outcome === 'denied' || e.outcome === 'failure' ? 'denied' : undefined}>{eventLabel(e.eventType)}</span>
            {e.fileId && fileNames?.[e.fileId] && !('fileName' in (e.details ?? {})) ? <span className="muted"> · {fileNames[e.fileId]}</span> : null}
            <div className="who">
              {who(e)}
              {detail(e) ? ` · ${detail(e)}` : ''}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
