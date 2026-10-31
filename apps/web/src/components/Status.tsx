import type { DeletionStatus, ScanStatus, TransferStatus, UploadStatus, GrantStatus } from '@snelson/shared';

type Tone = 'neutral' | 'progress' | 'ok' | 'warn' | 'err';

export function Badge({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return (
    <span className={`status status-${tone}`} title={title}>
      {label}
    </span>
  );
}

/** Honest transfer state labels. Expiry is time-based so an active-but-past-expiry transfer reads "Expired". */
export function transferState(t: { status: TransferStatus; deletionStatus: DeletionStatus; expiresAt: string }, now = Date.now()): { tone: Tone; label: string } {
  if (t.deletionStatus === 'deleted') return { tone: 'neutral', label: 'Deleted' };
  if (t.deletionStatus === 'failed') return { tone: 'err', label: 'Deletion failed' };
  if (t.deletionStatus === 'pending' || t.deletionStatus === 'in_progress') return { tone: 'warn', label: 'Deletion pending' };
  switch (t.status) {
    case 'draft':
      return { tone: 'neutral', label: 'Draft' };
    case 'uploading':
      return { tone: 'progress', label: 'Uploading' };
    case 'scanning':
      return { tone: 'progress', label: 'Scanning' };
    case 'ready':
      return { tone: 'ok', label: 'Ready to send' };
    case 'sending':
      return { tone: 'progress', label: 'Sending' };
    case 'active':
      return new Date(t.expiresAt).getTime() <= now ? { tone: 'neutral', label: 'Expired' } : { tone: 'ok', label: 'Active' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
    case 'revoked':
      return { tone: 'err', label: 'Revoked' };
  }
}

export function TransferBadge({ t }: { t: { status: TransferStatus; deletionStatus: DeletionStatus; expiresAt: string } }) {
  const s = transferState(t);
  return <Badge tone={s.tone} label={s.label} />;
}

export function scanLabel(s: ScanStatus): { tone: Tone; label: string } {
  switch (s) {
    case 'pending':
      return { tone: 'neutral', label: 'Awaiting scan' };
    case 'scanning':
      return { tone: 'progress', label: 'Scanning' };
    case 'clean':
      return { tone: 'ok', label: 'Scan passed' };
    case 'infected':
      return { tone: 'err', label: 'Blocked: malware detected' };
    case 'oversized':
      return { tone: 'warn', label: 'Not scanned: too large for scanner' };
    case 'timeout':
      return { tone: 'err', label: 'Scan timed out' };
    case 'unavailable':
      return { tone: 'err', label: 'Scanner unavailable' };
    case 'skipped':
      return { tone: 'warn', label: 'Scan skipped' };
    default:
      return { tone: 'err', label: 'Scan failed' };
  }
}

export function uploadLabel(u: UploadStatus): { tone: Tone; label: string } {
  switch (u) {
    case 'pending':
      return { tone: 'neutral', label: 'Not started' };
    case 'uploading':
      return { tone: 'progress', label: 'Uploading' };
    case 'finalised':
      return { tone: 'ok', label: 'Uploaded' };
    case 'abandoned':
      return { tone: 'err', label: 'Abandoned' };
  }
}

export function grantLabel(g: GrantStatus): { tone: Tone; label: string } {
  if (g === 'revoked') return { tone: 'err', label: 'Revoked' };
  if (g === 'invited') return { tone: 'ok', label: 'Invited' };
  return { tone: 'neutral', label: 'Pending' };
}
