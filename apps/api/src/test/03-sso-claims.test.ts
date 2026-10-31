import { describe, it, expect } from 'vitest';
import { IdentitySchema } from '@snelson/shared';
import { OidcError, roleFromGroups, validateClaims } from '../auth/oidc.js';

const settings = IdentitySchema.parse({
  ssoEnabled: true,
  oidc: {
    issuer: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
    clientId: 'client-abc',
    tenantId: '11111111-1111-1111-1111-111111111111',
    allowedUserObjectIds: ['user-oid-1'],
    allowedGroupIds: ['group-senders'],
    adminGroupIds: ['group-admins'],
    auditorGroupIds: ['group-auditors'],
  },
});
const good = {
  iss: settings.oidc.issuer,
  aud: 'client-abc',
  tid: '11111111-1111-1111-1111-111111111111',
  oid: 'user-oid-1',
  sub: 'pairwise-sub',
  preferred_username: 'Alex@Example.com',
  name: 'Alex',
  groups: ['group-senders'],
  amr: ['pwd', 'mfa'],
};
const reason = (claims: Record<string, unknown>, s = settings) => {
  try {
    validateClaims(claims, s);
    return 'ok';
  } catch (e) {
    return e instanceof OidcError ? e.reason : 'other';
  }
};

describe('3. SSO rejects wrong tenant, issuer, audience and unapproved users/groups', () => {
  it('accepts a valid claim set and keys identity on oid', () => {
    const id = validateClaims(good, settings);
    expect(id.subject).toBe('user-oid-1');
    expect(id.email).toBe('alex@example.com');
    expect(id.tenantId).toBe(good.tid);
  });
  it('rejects wrong issuer', () => expect(reason({ ...good, iss: 'https://login.microsoftonline.com/other/v2.0' })).toBe('issuer_mismatch'));
  it('rejects wrong audience (string and array)', () => {
    expect(reason({ ...good, aud: 'someone-else' })).toBe('audience_mismatch');
    expect(reason({ ...good, aud: ['someone-else', 'x'] })).toBe('audience_mismatch');
    expect(reason({ ...good, aud: ['x', 'client-abc'] })).toBe('ok');
  });
  it('rejects wrong tenant', () => expect(reason({ ...good, tid: '22222222-2222-2222-2222-222222222222' })).toBe('tenant_mismatch'));
  it('rejects a user who is neither allow-listed nor in an allowed group (email suffix alone grants nothing)', () => {
    expect(reason({ ...good, oid: 'stranger', groups: [] })).toBe('not_allowed');
    expect(reason({ ...good, oid: 'stranger', groups: ['group-unrelated'], preferred_username: 'ceo@snelsonserver.com' })).toBe('not_allowed');
    expect(reason({ ...good, oid: 'stranger', groups: ['group-senders'] })).toBe('ok');
  });
  it('rejects missing subject', () => expect(reason({ ...good, oid: undefined, sub: undefined })).toBe('no_subject'));
  it('honours requireAmrMfa', () => {
    const s = IdentitySchema.parse({ ...settings, oidc: { ...settings.oidc, requireAmrMfa: true } });
    expect(reason({ ...good, amr: ['pwd'] }, s)).toBe('mfa_not_reported');
    expect(reason(good, s)).toBe('ok');
  });
  it('maps roles only from trusted group configuration', () => {
    expect(roleFromGroups(validateClaims(good, settings), settings)).toBe('sender');
    expect(roleFromGroups(validateClaims({ ...good, groups: ['group-admins'] }, settings), settings)).toBe('admin');
    expect(roleFromGroups(validateClaims({ ...good, groups: ['group-auditors'] }, settings), settings)).toBe('auditor');
    expect(roleFromGroups(validateClaims({ ...good, groups: ['group-admins', 'group-auditors'] }, settings), settings)).toBe('admin');
    // a 'role' claim in the token is ignored
    expect(roleFromGroups(validateClaims({ ...good, roles: ['admin'] }, settings), settings)).toBe('sender');
  });
});
