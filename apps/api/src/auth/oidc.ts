import * as client from 'openid-client';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import type { IdentitySettings } from '@securesend/shared';

export interface OidcIdentity {
  issuer: string;
  subject: string; // oid when present (stable Entra object id), else sub
  tenantId: string | null;
  email: string | null;
  name: string;
  groups: string[];
  amr: string[];
  acr: string | null;
}

export class OidcError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
  }
}

/** Discover and build a client Configuration. Cached per (issuer, clientId, secret) signature. */
let cached: { sig: string; config: client.Configuration } | null = null;

export async function getOidcConfiguration(ctx: AppContext, settings: IdentitySettings): Promise<client.Configuration> {
  const o = settings.oidc;
  if (!o.issuer || !o.clientId) throw new OidcError('SSO is not configured', 'not_configured');
  const secret = await ctx.settings.getSecret('oidc.clientSecret');
  const sig = JSON.stringify([o.issuer, o.clientId, secret ? secret.length : 0]);
  if (cached && cached.sig === sig) return cached.config;
  const issuerUrl = new URL(o.issuer);
  const config = await client.discovery(issuerUrl, o.clientId, secret ? { client_secret: secret } : undefined, secret ? client.ClientSecretPost(secret) : client.None(), {
    execute: ctx.config.isProd ? [] : [client.allowInsecureRequests],
  });
  const meta = config.serverMetadata();
  // Explicit issuer check – discovery validates this but we re-check against the configured value.
  if (meta.issuer !== o.issuer.replace(/\/$/, '') && meta.issuer !== o.issuer) {
    throw new OidcError(`Issuer mismatch: discovered ${meta.issuer}`, 'issuer_mismatch');
  }
  cached = { sig, config };
  return config;
}

export function resetOidcCache() {
  cached = null;
}

export function redirectUri(ctx: AppContext): string {
  return new URL('/api/auth/sso/callback', ctx.config.publicUrl).toString();
}

export async function beginLogin(ctx: AppContext, q: Queryable, settings: IdentitySettings): Promise<{ url: string; challengeId: string }> {
  const config = await getOidcConfiguration(ctx, settings);
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
  const nonce = client.randomNonce();
  const params: Record<string, string> = {
    redirect_uri: redirectUri(ctx),
    scope: settings.oidc.scopes || 'openid profile email',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
    response_mode: 'query',
  };
  if (settings.oidc.acrValues) params.acr_values = settings.oidc.acrValues;
  const url = client.buildAuthorizationUrl(config, params);
  const r = await q.query<{ id: string }>(
    `INSERT INTO auth_challenges(user_id, purpose, challenge, data, expires_at) VALUES (NULL, 'oidc_login', $1, $2, now() + interval '10 minutes') RETURNING id`,
    [state, JSON.stringify({ codeVerifier, nonce })],
  );
  return { url: url.toString(), challengeId: r.rows[0]!.id };
}

/**
 * Complete the authorisation-code flow and validate claims against the configured tenant,
 * issuer, audience and allow lists. Throws OidcError with a reason that is safe to audit.
 */
export async function completeLogin(ctx: AppContext, q: Queryable, settings: IdentitySettings, challengeId: string, currentUrl: URL): Promise<OidcIdentity> {
  const ch = await q.query<{ challenge: string; data: { codeVerifier: string; nonce: string } }>(
    `UPDATE auth_challenges SET consumed_at = now() WHERE id = $1 AND purpose = 'oidc_login' AND consumed_at IS NULL AND expires_at > now() RETURNING challenge, data`,
    [challengeId],
  );
  const c = ch.rows[0];
  if (!c) throw new OidcError('Login attempt expired or already used', 'state_missing');
  const config = await getOidcConfiguration(ctx, settings);
  let tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers;
  try {
    tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: c.data.codeVerifier,
      expectedState: c.challenge,
      expectedNonce: c.data.nonce,
      idTokenExpected: true,
    });
  } catch (e) {
    throw new OidcError(`Token exchange failed: ${e instanceof Error ? e.message : String(e)}`, 'token_exchange_failed');
  }
  const claims = tokens.claims();
  if (!claims) throw new OidcError('No ID token returned', 'no_id_token');
  return validateClaims(claims as Record<string, unknown>, settings);
}

/** Pure claim validation (unit-tested with crafted claim sets). */
export function validateClaims(claims: Record<string, unknown>, settings: IdentitySettings): OidcIdentity {
  const o = settings.oidc;
  const iss = String(claims.iss ?? '');
  if (!iss || (iss !== o.issuer && iss !== o.issuer.replace(/\/$/, ''))) throw new OidcError('Issuer not trusted', 'issuer_mismatch');
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(o.clientId) : aud === o.clientId;
  if (!audOk) throw new OidcError('Audience mismatch', 'audience_mismatch');
  const tid = typeof claims.tid === 'string' ? claims.tid : null;
  if (o.tenantId && tid !== o.tenantId) throw new OidcError('Tenant not allowed', 'tenant_mismatch');
  const oid = typeof claims.oid === 'string' ? claims.oid : null;
  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  const subject = oid ?? sub;
  if (!subject) throw new OidcError('No subject claim', 'no_subject');
  const groups = Array.isArray(claims.groups) ? (claims.groups as unknown[]).filter((g): g is string => typeof g === 'string') : [];
  const userAllowed = o.allowedUserObjectIds.includes(subject);
  const groupAllowed = o.allowedGroupIds.some((g) => groups.includes(g));
  const adminAllowed = o.adminGroupIds.some((g) => groups.includes(g));
  const auditorAllowed = o.auditorGroupIds.some((g) => groups.includes(g));
  if (!userAllowed && !groupAllowed && !adminAllowed && !auditorAllowed) throw new OidcError('User is not in the allow list', 'not_allowed');
  const amr = Array.isArray(claims.amr) ? (claims.amr as unknown[]).filter((a): a is string => typeof a === 'string') : [];
  if (o.requireAmrMfa && !amr.includes('mfa')) throw new OidcError('IdP did not report multi-factor authentication', 'mfa_not_reported');
  const email = typeof claims.preferred_username === 'string' ? claims.preferred_username : typeof claims.email === 'string' ? claims.email : null;
  return {
    issuer: iss,
    subject,
    tenantId: tid,
    email: email ? email.toLowerCase() : null,
    name: typeof claims.name === 'string' ? claims.name : (email ?? subject),
    groups,
    amr,
    acr: typeof claims.acr === 'string' ? claims.acr : null,
  };
}

export function roleFromGroups(identity: OidcIdentity, settings: IdentitySettings): 'sender' | 'auditor' | 'admin' {
  const o = settings.oidc;
  if (o.adminGroupIds.some((g) => identity.groups.includes(g))) return 'admin';
  if (o.auditorGroupIds.some((g) => identity.groups.includes(g))) return 'auditor';
  return 'sender';
}
