import type { CurrentUser } from '@securesend/shared';

export interface MfaStatus {
  totp: boolean;
  passkeys: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[];
  recoveryCodesRemaining: number;
  enrolled: boolean;
}
export interface MeResponse {
  user: CurrentUser | null;
  mfa?: MfaStatus;
}
export interface AuthOptions {
  localLoginEnabled: boolean;
  ssoEnabled: boolean;
  ssoLabel: string;
  productName: string;
  organisationName: string;
  accentColour: string;
  logoDataUrl: string | null;
  supportEmail: string | null;
}
