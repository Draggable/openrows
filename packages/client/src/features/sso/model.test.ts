import type { SsoConnection } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { formFrom, inputFrom, ssoUnavailable } from './model';

const connection: SsoConnection = {
  alias: 'ws-1',
  protocol: 'oidc',
  displayName: 'Okta',
  enabled: true,
  requireSso: true,
  jit: false,
  defaultRole: 'commenter',
  oidc: { issuer: 'https://acme.okta.com', clientId: 'abc' },
  saml: null,
  createdAt: '2026-10-29T00:00:00.000Z',
  updatedAt: '2026-10-29T00:00:00.000Z',
};

describe('single sign-on form (#158)', () => {
  it('starts from the connection, secrets empty', () => {
    expect(formFrom(null)).toMatchObject({
      protocol: 'oidc',
      enabled: true,
      jit: true,
      defaultRole: 'editor',
    });
    expect(formFrom(connection)).toMatchObject({
      issuer: 'https://acme.okta.com',
      clientId: 'abc',
      clientSecret: '',
      requireSso: true,
      jit: false,
      defaultRole: 'commenter',
    });
  });

  it('sends the secret and the certificate only when typed', () => {
    const form = formFrom(connection);
    expect(inputFrom(form)).toEqual({
      protocol: 'oidc',
      displayName: 'Okta',
      enabled: true,
      requireSso: true,
      jit: false,
      defaultRole: 'commenter',
      oidc: { issuer: 'https://acme.okta.com', clientId: 'abc' },
    });
    expect(inputFrom({ ...form, clientSecret: 's3' })).toMatchObject({
      oidc: { clientSecret: 's3' },
    });
    const saml = {
      ...form,
      protocol: 'saml' as const,
      entityId: ' idp ',
      ssoUrl: 'https://idp.test',
    };
    expect(inputFrom(saml)).toMatchObject({
      saml: { entityId: 'idp', ssoUrl: 'https://idp.test' },
    });
    expect(inputFrom(saml)).not.toHaveProperty('saml.signingCertificate');
    expect(inputFrom({ ...saml, certificate: 'MIIB' })).toMatchObject({
      saml: { signingCertificate: 'MIIB' },
    });
  });

  it('tells the edition and the plan apart', () => {
    expect(ssoUnavailable(new ApiError(404, 'Not found'))).toBe('edition');
    expect(ssoUnavailable(new ApiError(403, 'Plan', {}, 'PLAN_FEATURE_REQUIRED'))).toBe('plan');
    expect(ssoUnavailable(new Error('x'))).toBe('error');
  });
});
