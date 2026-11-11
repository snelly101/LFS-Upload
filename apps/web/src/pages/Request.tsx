import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TransferDetail, TransferPolicy } from '@securesend/shared';
import { post, get, errorMessage } from '../api';
import { Picker } from '../components/Picker';
import { PeopleInput, EMAIL_RE } from '../components/PeopleInput';
import { fmtLong, toLocalInput, fromLocalInput } from '../lib/time';
import { peopleLabel, refCode } from '../lib/labels';
import { RecentSends } from './Sent';

type Preset = '1d' | '3d' | '7d' | '14d' | '30d' | 'custom';
const DAYS: Record<Exclude<Preset, 'custom'>, number> = { '1d': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30 };

/**
 * Ask named people outside the organisation to send files in. The reverse of the composer: no
 * files to add, just who, what for and until when. Each person gets their own link and must verify
 * their mailbox before they can see the request or upload anything.
 */
export default function RequestPage() {
  const qc = useQueryClient();
  const policyQ = useQuery({ queryKey: ['transfer-policy'], queryFn: () => get<{ transferPolicy: TransferPolicy }>('/api/transfers/policy') });
  const tp = policyQ.data?.transferPolicy;
  const [emails, setEmails] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [preset, setPreset] = useState<Preset>('7d');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<TransferDetail | null>(null);
  const from = useRef<HTMLInputElement>(null);
  const live = useRef<HTMLDivElement>(null);

  useEffect(() => {
    from.current?.focus();
  }, []);

  const maxHours = tp?.maxExpiryHours ?? 24 * 30;
  const closesIso = useMemo(() => {
    if (preset === 'custom') return custom ? fromLocalInput(custom) : null;
    return new Date(Date.now() + Math.min(DAYS[preset] * 24, maxHours) * 3_600_000).toISOString();
  }, [preset, custom, maxHours]);

  const invalid = emails.filter((e) => !EMAIL_RE.test(e));
  const notPermitted = useMemo(() => {
    const allowed = tp?.allowedRecipientDomains ?? [];
    if (!allowed.length) return [];
    return emails.filter((e) => {
      const dom = e.split('@')[1] ?? '';
      return !allowed.some((d) => dom === d.toLowerCase() || dom.endsWith('.' + d.toLowerCase()));
    });
  }, [emails, tp]);

  let why: string | null = null;
  if (emails.length === 0) why = 'Add at least one person to ask.';
  else if (invalid.length) why = `Check this address: ${invalid.join(', ')}.`;
  else if (notPermitted.length) why = `Not permitted by policy: ${notPermitted.join(', ')}.`;
  else if (tp && emails.length > tp.maxRecipientsPerTransfer) why = `You can ask at most ${tp.maxRecipientsPerTransfer} people at once.`;
  else if (!title.trim()) why = 'Say what you need.';
  else if (!closesIso) why = 'Choose a closing date.';
  else if (new Date(closesIso).getTime() <= Date.now()) why = 'The closing date must be in the future.';
  else if (new Date(closesIso).getTime() > Date.now() + maxHours * 3_600_000) why = `The closing date cannot be later than ${fmtLong(new Date(Date.now() + maxHours * 3_600_000))}.`;
  const canSend = why === null && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await post<TransferDetail>('/api/requests', { title: title.trim(), message, emails, expiresAt: closesIso ?? undefined });
      setSent(r);
      void qc.invalidateQueries({ queryKey: ['transfers'] });
      if (live.current) live.current.textContent = `Request sent to ${emails.join(', ')}.`;
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  if (tp && tp.allowFileRequests === false) {
    return (
      <div className="home">
        <div className="empty">
          <h1 style={{ fontSize: '1.5rem' }}>File requests are turned off</h1>
          <p>Your administrator has switched this feature off. You can still send files.</p>
          <Link to="/" className="btn btn-primary">Send files</Link>
        </div>
      </div>
    );
  }

  if (sent) {
    const who = sent.grants.map((g) => g.email);
    return (
      <div className="home">
        <section className="ticket" aria-live="polite" aria-label="Request confirmation">
          <div className="ticket-main">
            <p className="caps" style={{ marginBottom: 6 }}>Requested</p>
            <h1>Request sent to {peopleLabel(who)}</h1>
            <p>
              {who.map((w) => <strong key={w}>{w}</strong>).reduce<ReactNode[]>((acc, el, i) => (i ? [...acc, ', ', el] : [el]), [])} will get an email with a personal link. They enter a code we email them before they can see what you asked for or send anything.
            </p>
            <p>
              Open until <strong>{fmtLong(sent.expiresAt)}</strong>. We'll tell you when files arrive; everything is deleted on the closing date.
            </p>
            <p className="row" style={{ marginTop: 18, marginBottom: 0 }}>
              <Link to={`/sent/${sent.id}`} className="btn btn-primary">Track it</Link>
              <button type="button" className="btn" onClick={() => { setSent(null); setEmails([]); setTitle(''); setMessage(''); setShowNote(false); }}>Ask someone else</button>
            </p>
          </div>
          <div className="ticket-stub">
            <dl>
              <div><dt>Reference</dt><dd>{refCode(sent.id)}</dd></div>
              <div><dt>Asked</dt><dd>{who.length} {who.length === 1 ? 'person' : 'people'}</dd></div>
            </dl>
            <span className="stamp stamp-ok lg">Requested</span>
          </div>
        </section>
        <RecentSends />
      </div>
    );
  }

  const options = (['1d', '3d', '7d', '14d', '30d'] as const).filter((k) => DAYS[k] * 24 <= maxHours).map((k) => ({ value: k as Preset, label: `${DAYS[k]} day${DAYS[k] === 1 ? '' : 's'}` }));
  options.push({ value: 'custom', label: 'A specific date and time' });
  const word = preset === 'custom' ? (closesIso ? fmtLong(closesIso) : 'a date you choose') : `${DAYS[preset]} day${DAYS[preset] === 1 ? '' : 's'}`;

  return (
    <div className="home">
      <div ref={live} className="visually-hidden" aria-live="polite" />
      {err && <div className="notice notice-err" role="alert">{err}</div>}
      <form className="composer" onSubmit={(e) => void submit(e)} aria-labelledby="req-h">
        <div className="composer-files" style={{ paddingBottom: 16 }}>
          <span className="tag tag-in" style={{ marginBottom: 8 }}><span aria-hidden="true">↓</span> Incoming</span>
          <h1 id="req-h" style={{ fontSize: '1.5rem', margin: '0 0 4px' }}>Ask someone to send you files</h1>
          <p className="muted" style={{ margin: 0 }}>They get a personal link. Only the people you name can use it, and only you can open what they send.</p>
        </div>
        <div className="composer-line">
          <label htmlFor="req-from">From</label>
          <PeopleInput id="req-from" inputRef={from} value={emails} onChange={setEmails} invalid={notPermitted} ariaLabel="Who should send the files" placeholder="Email addresses of the people you are asking" />
        </div>
        <div className="composer-line stack">
          <label htmlFor="req-title">What do you need?</label>
          <input id="req-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder="For example: signed tenancy agreement and proof of address" />
        </div>
        {showNote ? (
          <div className="composer-line stack">
            <label htmlFor="req-note">Note</label>
            <textarea id="req-note" className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} placeholder="Shown to them after they verify, with your request." autoFocus />
          </div>
        ) : (
          <div className="composer-line stack">
            <button type="button" className="addmore" style={{ margin: 0 }} onClick={() => setShowNote(true)}>+ Add a note</button>
          </div>
        )}
        <div className="composer-foot">
          <div className="sentence" style={{ margin: 0, width: '100%' }}>
            {preset === 'custom' ? 'Open until' : 'Open for'}{' '}
            <Picker<Preset>
              ariaLabel="How long the request stays open"
              value={preset}
              options={options}
              onChange={setPreset}
              custom={
                preset === 'custom' ? (
                  <div className="custom">
                    <label htmlFor="req-custom" className="small">Open until</label>
                    <input id="req-custom" className="input" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} max={toLocalInput(new Date(Date.now() + maxHours * 3_600_000).toISOString())} />
                  </div>
                ) : (
                  <div className="note">Uploading stops and everything received is deleted on the closing date. Maximum {Math.round(maxHours / 24)} days.</div>
                )
              }
            >
              {word}
            </Picker>
            {preset !== 'custom' && closesIso && <span className="muted small"> (until {fmtLong(closesIso)})</span>}
          </div>
          <div className="small muted" style={{ margin: 0, width: '100%' }} aria-live="polite">
            {emails.length > 0 ? `Only ${emails.length === 1 ? emails[0] : `these ${emails.length} people`} can upload.` : 'Only the people you name can upload.'} Each must verify by email code first. Every file is checked for malware before you can open it.{closesIso ? ` Everything is deleted on ${fmtLong(closesIso)}.` : ''}
          </div>
          <span className="why grow" aria-live="polite">{why ?? ''}</span>
          <button type="submit" className="btn btn-primary sendbtn" disabled={!canSend}>
            {busy ? 'Sending…' : `Send request to ${emails.length ? peopleLabel(emails) : '…'}`}
          </button>
        </div>
      </form>
      <RecentSends />
    </div>
  );
}
