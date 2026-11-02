# Microsoft Entra ID (OpenID Connect) setup

Together Housing Secure File Send uses the authorisation-code flow with PKCE, `state` and `nonce`, via `openid-client`
(`apps/api/src/auth/oidc.ts`). Issuer, audience (client id), tenant and allow lists are checked explicitly
on every login in `validateClaims()`. Nothing is granted on the basis of an email domain.

## 1. App registration
1. Entra admin centre → App registrations → **New registration**.
   * Name: Together Housing Secure File Send. Supported account types: **this organisational directory only** (single tenant).
   * Redirect URI (Web): `https://<PUBLIC_HOST>/api/auth/sso/callback` — must match `PUBLIC_URL` exactly.
2. Certificates & secrets → **New client secret**. Copy the value now; it is only shown once. Set a reminder for its expiry.
3. Token configuration → **Add groups claim** → Security groups → for ID tokens emit **Group ID**.
   Overage caveat: if a user is in more than 200 groups (150 for SAML) Entra omits the `groups` claim and
   sets `_claim_names`/`_claim_sources` instead. Together Housing Secure File Send does **not** follow the Graph overage link;
   such users will be rejected as "not in the allow list" unless they are listed by object id, or you
   restrict the claim to "groups assigned to the application" (Enterprise application → Users and groups,
   then choose that option in Token configuration).
4. Optional claims (ID token): `email`, `preferred_username`, `acct`. `oid`, `tid`, `sub`, `amr`, `name` are present by default.
5. API permissions: `openid`, `profile`, `email` (delegated). Grant admin consent.
6. Enterprise application → Properties → **Assignment required: Yes**, and assign the groups that may use the service.

## 2. Conditional Access (MFA)
The application cannot prove that MFA happened unless the IdP says so. Create a Conditional Access policy
targeting the Together Housing Secure File Send enterprise application that **requires multifactor authentication** (or an
authentication strength) for all assigned users. Then in Together Housing Secure File Send → Administration → Identity &
access enable **Require `amr` to contain `mfa`** so logins whose ID token does not report MFA are
rejected. Note: `amr` reporting depends on the IdP and the method; if your tenant uses phishing-resistant
methods that report differently, verify the claim content in a test login before enabling the check.
`acr_values` can be set if your tenant uses authentication context; otherwise leave it blank and rely on
Conditional Access.

## 3. Configure Together Housing Secure File Send
Administration → Identity & access (requires recent strong authentication and a reason; the change is audited):

| Field | Value |
|---|---|
| Issuer | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| Client ID | Application (client) ID |
| Client secret | the secret value (stored AES-256-GCM encrypted with `SERVER_SECRET_KEY`; never displayed again) |
| Tenant ID | Directory (tenant) ID — the `tid` claim must equal this |
| Allowed user object IDs | individual users' object IDs (optional) |
| Allowed group IDs | security group object IDs whose members may sign in as **sender** |
| Admin group IDs / Auditor group IDs | groups mapped to those roles; evaluated on every login |
| Require amr=mfa | see §2 |

Roles are mapped only from these trusted group lists. A user in none of the lists is refused even with a
valid token and a matching email domain.

## 4. Test before enforcing
Click **Test SSO configuration**: it performs OIDC discovery and checks the discovered issuer equals the
configured one. The *Enforce SSO (disable local login)* switch is refused until a successful test is on
record within 7 days, and at least one sign-in method must remain enabled, so an administrator cannot
lock everyone out with a typo. Complete a real sign-in in a private window before enforcing.

## 5. Provisioning and deprovisioning
* First login auto-creates a local user record with `auth_kind = sso` keyed by `(issuer, oid)`. If an account
  with the same email already exists (e.g. a local account), login is refused with `email_clash`; an
  administrator must disable or delete the old account first. There is no automatic linking by email.
* Removing a user from all allowed groups, or disabling them in Entra, blocks **new** logins immediately.
  Existing application sessions continue until the idle limit (default 60 min) or absolute limit (default
  12 h), whichever comes first, because the application does not call back to Entra during a session.
  Mitigations: shorten the limits in Identity & access (recommended: idle 30 min, absolute 8 h for
  SSO-only tenants); an administrator can revoke a user's sessions or disable the account in
  Administration → Users, which takes effect on the next request.
* Role changes via group membership apply at the next login; the previous session keeps its old role until it expires or is revoked.

## 6. Another OIDC provider
Any provider that supports discovery (`/.well-known/openid-configuration`), the code flow with PKCE and
`client_secret_post` works. Set the issuer to the provider's `iss` value. If the provider does not emit
`oid`, the `sub` claim is used as the stable subject; `tid` checking can be disabled by leaving Tenant ID
blank. SAML is not implemented; it is documented as a possible later adapter (docs/ARCHITECTURE.md).
