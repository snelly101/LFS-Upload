import type { GrantView } from '@securesend/shared';
import { fmtShort } from '../lib/time';

/**
 * Honest three-step strip for one recipient: Sent → Opened → Downloaded.
 * "Opened" means the recipient verified their email and viewed the page (or, for bearer links,
 * that an unverified link holder opened it). A bare link fetch is not shown here; it is in the history.
 */
export function Steps({ g, totalFiles, verificationMode, transferLive }: { g: GrantView; totalFiles: number; verificationMode: 'required' | 'bearer'; transferLive: boolean }) {
  const revoked = g.status === 'revoked';
  const sent = g.invitationStatus === 'accepted_by_provider' || g.invitationStatus === 'queued' || !!g.invitedAt;
  const sentDone = g.invitationStatus === 'accepted_by_provider';
  const sentFailed = g.invitationStatus === 'failed';
  const opened = !!g.firstVerifiedAt;
  const done = !!g.allFilesCompletedAt;
  const partial = !done && g.filesCompleted > 0;
  const cls = (state: 'off' | 'on' | 'done' | 'stop') => (state === 'off' ? '' : state);
  const s1 = revoked ? 'stop' : sentFailed ? 'stop' : sentDone ? 'done' : sent ? 'on' : 'off';
  const s2 = revoked ? 'stop' : opened ? 'done' : s1 === 'done' && transferLive ? 'on' : 'off';
  const s3 = revoked ? 'stop' : done ? 'done' : partial ? 'on' : opened && transferLive ? 'on' : 'off';
  return (
    <ol className="steps" aria-label={`Progress for ${g.email}`}>
      <li className={cls(s1)}>
        {sentFailed ? 'Not delivered' : sentDone ? 'Sent' : sent ? 'Sending' : 'Not sent'}
        <small>{sentFailed ? 'mail server refused' : g.invitedAt ? fmtShort(g.invitedAt) : ''}</small>
      </li>
      <li className={cls(s2)}>
        {opened ? (verificationMode === 'bearer' ? 'Opened (unverified)' : 'Opened') : 'Not opened'}
        <small>{g.firstVerifiedAt ? fmtShort(g.firstVerifiedAt) : g.firstLinkSeenAt ? 'fetched, unverified' : ''}</small>
      </li>
      <li className={cls(s3)}>
        {done ? 'Downloaded' : partial ? `${g.filesCompleted} of ${totalFiles} files` : 'Not downloaded'}
        <small>{g.allFilesCompletedAt ? fmtShort(g.allFilesCompletedAt) : revoked ? 'revoked' : ''}</small>
      </li>
    </ol>
  );
}

/** One plain-English sentence summarising where a transfer stands. */
export function headline(t: { status: string; deletionStatus: string; expiresAt: string; grants: GrantView[]; files: { storageState: string }[]; title: string }): string {
  const live = t.status === 'active' && t.deletionStatus === 'none' && new Date(t.expiresAt).getTime() > Date.now();
  const active = t.grants.filter((g) => g.status !== 'revoked');
  const done = active.filter((g) => g.allFilesCompletedAt);
  const opened = active.filter((g) => g.firstVerifiedAt && !g.allFilesCompletedAt);
  const name = (g: GrantView) => g.email;
  if (t.deletionStatus === 'deleted') return 'Files deleted. The record of what happened is kept.';
  if (t.deletionStatus === 'failed') return 'Deletion failed. Access is blocked and administrators have been alerted.';
  if (t.deletionStatus === 'pending' || t.deletionStatus === 'in_progress') return 'Access ended. Files are being deleted.';
  if (t.status === 'revoked') return 'You stopped sharing this transfer.';
  if (t.status === 'expired' || (t.status === 'active' && !live)) return done.length === active.length && active.length > 0 ? 'Expired. Everyone had downloaded everything.' : `Expired. ${done.length} of ${active.length} recipient${active.length === 1 ? '' : 's'} downloaded everything.`;
  if (['draft', 'uploading', 'scanning', 'ready'].includes(t.status)) return 'Not sent yet.';
  if (active.length === 0) return 'No recipients with access.';
  if (done.length === active.length) return active.length === 1 ? `${name(done[0]!)} has downloaded everything.` : `All ${active.length} recipients have downloaded everything.`;
  if (done.length > 0) return `${done.length} of ${active.length} recipients have downloaded everything.`;
  if (opened.length > 0) return active.length === 1 ? `${name(opened[0]!)} opened it but hasn't downloaded yet.` : `${opened.length} of ${active.length} recipients have opened it; none has downloaded everything yet.`;
  return active.length === 1 ? `Waiting for ${name(active[0]!)} to open it.` : `Waiting for recipients to open it.`;
}
