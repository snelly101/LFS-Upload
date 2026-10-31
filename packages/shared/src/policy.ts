import { z } from 'zod';

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;

/** Administrator-controlled transfer policy. Senders may only strengthen within these bounds. */
export const TransferPolicySchema = z.object({
  defaultExpiryHours: z.number().int().min(1).max(24 * 365).default(7 * 24),
  maxExpiryHours: z.number().int().min(1).max(24 * 365).default(30 * 24),
  maxFileBytes: z.number().int().min(1).default(100 * GiB),
  maxTransferBytes: z.number().int().min(1).default(250 * GiB),
  maxFilesPerTransfer: z.number().int().min(1).max(1000).default(100),
  maxRecipientsPerTransfer: z.number().int().min(1).max(200).default(20),
  defaultUserQuotaBytes: z.number().int().min(0).default(500 * GiB),
  organisationQuotaBytes: z.number().int().min(0).default(2 * 1024 * GiB),
  /** Allowed extensions, lower-case without dot; empty = all allowed. Blocked list wins. */
  allowedExtensions: z.array(z.string()).default([]),
  blockedExtensions: z.array(z.string()).default(['exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'msi', 'js', 'vbs', 'ps1', 'jar', 'hta', 'lnk']),
  /** Permitted recipient domains; empty = any. */
  allowedRecipientDomains: z.array(z.string()).default([]),
  /** Max downloads per recipient per transfer; null = unlimited. Senders may lower. */
  maxDownloadsPerRecipient: z.number().int().min(1).nullable().default(null),
  /** Whether senders may extend expiry of an active transfer (never beyond maxExpiryHours from send). */
  allowExpiryExtension: z.boolean().default(true),
  /** Whether files larger than the scanner limit may be released unscanned (default: no). */
  allowUnscannedOversizedRelease: z.boolean().default(false),
});
export type TransferPolicy = z.infer<typeof TransferPolicySchema>;

export const VerificationPolicySchema = z.object({
  /** required: always verify; sender_choice: sender may disable per transfer; disabled: bearer links. */
  mode: z.enum(['required', 'sender_choice', 'disabled']).default('required'),
  codeDigits: z.number().int().min(6).max(8).default(6),
  codeTtlSeconds: z.number().int().min(60).max(1800).default(600),
  maxAttempts: z.number().int().min(3).max(10).default(5),
  resendCooldownSeconds: z.number().int().min(30).max(600).default(60),
  maxCodesPerGrantPerHour: z.number().int().min(3).max(30).default(6),
  maxCodesPerTransferPerHour: z.number().int().min(10).max(500).default(60),
  maxCodesPerSourcePerHour: z.number().int().min(5).max(200).default(20),
  recipientSessionMinutes: z.number().int().min(5).max(24 * 60).default(60),
});
export type VerificationPolicy = z.infer<typeof VerificationPolicySchema>;

export const NotificationPolicySchema = z.object({
  senderChoices: z
    .object({
      firstVerifiedView: z.boolean().default(true),
      firstDownload: z.boolean().default(true),
      everyDownload: z.boolean().default(true),
      expiringSoon: z.boolean().default(true),
      expiredWithoutDownload: z.boolean().default(true),
      deletionCompleted: z.boolean().default(true),
    })
    .default({}),
  defaults: z
    .object({
      firstVerifiedView: z.boolean().default(true),
      firstDownload: z.boolean().default(true),
      everyDownload: z.boolean().default(false),
      expiringSoon: z.boolean().default(true),
      expiredWithoutDownload: z.boolean().default(true),
      deletionCompleted: z.boolean().default(false),
    })
    .default({}),
  expiringSoonLeadHours: z.number().int().min(1).max(168).default(24),
  remindOutstandingRecipients: z.boolean().default(false),
  scanFailureEmail: z.boolean().default(true),
  adminAlertEmails: z.array(z.string().email()).default([]),
});
export type NotificationPolicy = z.infer<typeof NotificationPolicySchema>;

export const StoragePolicySchema = z.object({
  deletionTargetMinutes: z.number().int().min(1).max(1440).default(5),
  abandonedUploadHours: z.number().int().min(1).max(24 * 30).default(48),
  draftTransferDays: z.number().int().min(1).max(365).default(7),
  lowDiskWarnPercent: z.number().int().min(1).max(99).default(15),
  lowDiskCriticalPercent: z.number().int().min(1).max(99).default(5),
  backupVerificationNote: z.string().default(''),
  lastBackupVerifiedAt: z.string().nullable().default(null),
});
export type StoragePolicy = z.infer<typeof StoragePolicySchema>;

export const AuditPolicySchema = z.object({
  auditRetentionDays: z.number().int().min(30).max(3650).default(365),
  /** After content deletion + this many days, filenames and recipient addresses are anonymised. */
  metadataRetentionDays: z.number().int().min(1).max(3650).default(90),
  auditorsSeeRecipientEmails: z.boolean().default(true),
});
export type AuditPolicy = z.infer<typeof AuditPolicySchema>;

export const BrandingSchema = z.object({
  productName: z.string().min(1).max(60).default('Snelson Send'),
  organisationName: z.string().min(1).max(120).default('Snelsonserver Ltd'),
  supportEmail: z.string().email().nullable().default(null),
  supportUrl: z.string().url().nullable().default(null),
  accentColour: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#11665C'),
  logoDataUrl: z.string().max(200_000).nullable().default(null),
  defaultTimeZone: z.string().default('Europe/London'),
});
export type Branding = z.infer<typeof BrandingSchema>;

export const IdentitySchema = z.object({
  localLoginEnabled: z.boolean().default(true),
  ssoEnabled: z.boolean().default(false),
  ssoEnforced: z.boolean().default(false),
  oidc: z
    .object({
      providerLabel: z.string().default('Microsoft Entra ID'),
      issuer: z.string().default(''),
      clientId: z.string().default(''),
      /** stored encrypted; never returned */
      clientSecretSet: z.boolean().default(false),
      tenantId: z.string().default(''),
      allowedUserObjectIds: z.array(z.string()).default([]),
      allowedGroupIds: z.array(z.string()).default([]),
      adminGroupIds: z.array(z.string()).default([]),
      auditorGroupIds: z.array(z.string()).default([]),
      requireAmrMfa: z.boolean().default(false),
      acrValues: z.string().default(''),
      scopes: z.string().default('openid profile email'),
    })
    .default({}),
  sessionIdleMinutes: z.number().int().min(5).max(24 * 60).default(60),
  sessionAbsoluteHours: z.number().int().min(1).max(24 * 7).default(12),
  recentAuthMinutes: z.number().int().min(1).max(120).default(15),
});
export type IdentitySettings = z.infer<typeof IdentitySchema>;

export const SmtpSchema = z.object({
  host: z.string().default(''),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  username: z.string().default(''),
  passwordSet: z.boolean().default(false),
  from: z.string().default(''),
  replyTo: z.string().default(''),
});
export type SmtpSettings = z.infer<typeof SmtpSchema>;

export const SettingsSections = {
  branding: BrandingSchema,
  identity: IdentitySchema,
  transferPolicy: TransferPolicySchema,
  verification: VerificationPolicySchema,
  notifications: NotificationPolicySchema,
  smtp: SmtpSchema,
  storage: StoragePolicySchema,
  audit: AuditPolicySchema,
} as const;
export type SettingsKey = keyof typeof SettingsSections;
export type AllSettings = { [K in SettingsKey]: z.infer<(typeof SettingsSections)[K]> };

export function defaultSettings(): AllSettings {
  return {
    branding: BrandingSchema.parse({}),
    identity: IdentitySchema.parse({}),
    transferPolicy: TransferPolicySchema.parse({}),
    verification: VerificationPolicySchema.parse({}),
    notifications: NotificationPolicySchema.parse({}),
    smtp: SmtpSchema.parse({}),
    storage: StoragePolicySchema.parse({}),
    audit: AuditPolicySchema.parse({}),
  };
}

/** Effective policy snapshot stored on each transfer. */
export interface EffectivePolicy {
  verificationMode: 'required' | 'bearer';
  verificationPolicyMode: 'required' | 'sender_choice' | 'disabled';
  maxExpiryHours: number;
  maxDownloadsPerRecipient: number | null;
  allowExpiryExtension: boolean;
  recipientSessionMinutes: number;
  codeTtlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  policyVersionId: number | null;
}
