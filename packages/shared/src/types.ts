/** API view types shared between server and UI. */
export type UserRole = 'sender' | 'auditor' | 'admin';
export type TransferStatus = 'draft' | 'uploading' | 'scanning' | 'ready' | 'sending' | 'active' | 'expired' | 'revoked';
export type DeletionStatus = 'none' | 'pending' | 'in_progress' | 'deleted' | 'failed';
export type ScanStatus = 'pending' | 'scanning' | 'clean' | 'infected' | 'error' | 'unavailable' | 'oversized' | 'timeout' | 'skipped';
export type UploadStatus = 'pending' | 'uploading' | 'finalised' | 'abandoned';
export type GrantStatus = 'pending' | 'invited' | 'revoked';

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  authKind: 'local' | 'sso';
  mfaEnrolled: boolean;
  authLevel: 'password_only' | 'full';
  timeZone: string;
  notificationPrefs: Record<string, boolean>;
  recentAuthUntil: string | null;
}

export interface TransferFileView {
  id: string;
  displayName: string;
  sizeBytes: number;
  contentType: string;
  uploadStatus: UploadStatus;
  uploadedBytes: number;
  scanStatus: ScanStatus;
  scanDetail: string | null;
  storageState: string;
  createdAt: string;
}

export interface GrantView {
  id: string;
  email: string;
  status: GrantStatus;
  invitedAt: string | null;
  revokedAt: string | null;
  addedAfterSend: boolean;
  downloadsUsed: number;
  firstLinkSeenAt: string | null;
  firstVerifiedAt: string | null;
  allFilesCompletedAt: string | null;
  filesCompleted: number;
  invitationStatus: 'queued' | 'accepted_by_provider' | 'failed' | 'suppressed' | 'none';
}

export interface TransferSummary {
  id: string;
  title: string;
  status: TransferStatus;
  deletionStatus: DeletionStatus;
  recipients: { email: string; status: GrantStatus }[];
  fileCount: number;
  totalBytes: number;
  expiresAt: string;
  sentAt: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  lastActivityType: string | null;
  senderEmail: string;
  downloadsCompleted: number;
  recipientsCompleted: number;
}

export interface TransferDetail extends TransferSummary {
  message: string;
  verificationMode: 'required' | 'bearer';
  downloadLimitPerRecipient: number | null;
  notifyPrefs: Record<string, boolean>;
  effectivePolicy: Record<string, unknown>;
  files: TransferFileView[];
  grants: GrantView[];
  revokedAt: string | null;
  deletion: {
    requestedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    attempts: number;
    lastError: string | null;
  };
  canSend: boolean;
  blockingReasons: string[];
}

export interface ActivityEvent {
  id: number;
  occurredAt: string;
  eventType: string;
  actorKind: string;
  actorEmail: string | null;
  outcome: string;
  fileId: string | null;
  grantId: string | null;
  transferId: string | null;
  details: Record<string, unknown>;
}

export interface RecipientPublicView {
  state: 'needs_verification' | 'bearer_ready' | 'expired' | 'revoked' | 'unavailable' | 'not_found';
  productName: string;
  organisationName: string;
  supportEmail: string | null;
  recipientHint: string | null;
  verification: { codeTtlSeconds: number; resendCooldownSeconds: number } | null;
}

export interface RecipientAuthorisedView {
  title: string;
  message: string;
  senderName: string;
  senderEmail: string;
  recipientEmail: string | null;
  expiresAt: string;
  files: { id: string; name: string; sizeBytes: number }[];
  totalBytes: number;
  downloadsRemaining: number | null;
  sessionExpiresAt: string;
  allowZip: boolean;
}
