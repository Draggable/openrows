import { describe, expect, it } from 'vitest';
import {
  ssoAlias,
  ssoCertificateSchema,
  ssoConnectionInputSchema,
  ssoDomainSchema,
} from './sso.js';

const CERT =
  'MIIDGTCCAgGgAwIBAgIUcdrbV/RPRyCJfHkAjAEqMbQiQkcwDQYJKoZIhvcNAQELBQAwHDEaMBgGA1UEAwwRY3VzdG9tZXItaWRwLnRlc3QwHhcNMjYxMDI5MDUwNDM0WhcNMzYxMDI2MDUwNDM0WjAcMRowGAYDVQQDDBFjdXN0b21lci1pZHAudGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOGPOWWQ10N3QZt3Z3TuETf8K5YtOmChTyI+b66IRbAyHbXvU3F+FfO9+MAcYK8VYjvR+1iRD5lIU9cszgSzs//2TXOnwf3vD7OtfRQp0zS+n1cXqhv+mUt5CsZSCw3K76cRjcofGToVOT7K4RmN8Lh70ezdSU0jPPVc6ZWsDF+cdi1e7B/JzXxo7Bzqx+qi8wrTFDMMmu0jcPrKuOS1ldRQXfM/HFIH3a1EN+5c3WxeLyH8L0dSv+DrcSk36xjNe1ojuvkaEr17k9ZSkP955ht4SxrPOnv+6YveN+VCJBXdj6q87vfYtMWsQGU/JoXbCiEjEByNudLNQEI72wo0isMCAwEAAaNTMFEwHQYDVR0OBBYEFN/dN9eQKveu3/pLfgnUV5pPPNDvMB8GA1UdIwQYMBaAFN/dN9eQKveu3/pLfgnUV5pPPNDvMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAC3zoLYibPucJyXQSH5blYcWunLmJRkbVmY4g75VjXQp/92pzP0NsSP2l40AdzqeYVFGME/YOE9xwSSehKhYNzEYKUmnmJZttFTaOyIUCXWn5ws9wdJSUq4dBQEup/c+hftYQ96NlEoUL1kxw4M/21qpcGjvQe1aGY997CEJUaOJMce/ug3Ud/DN4LCrKY8IwiJhCtAuotY0SgZySNGX0jjA93PzcAeNFl3pxAXcgt516UXSfl3+poAGxL0izP2DVfYqqZPhtcxFyLM9TE5Fyl8u9526AQotUWdxFrG778MPadP9c13gon5eVstj2qWkg960KQCAQsMl2gQHnegNaU0=';

describe('single sign-on schemas (#158)', () => {
  it('takes domain names, lower-cased, and refuses anything else', () => {
    expect(ssoDomainSchema.parse(' Acme.COM ')).toBe('acme.com');
    expect(ssoDomainSchema.parse('mail.acme.co.uk')).toBe('mail.acme.co.uk');
    for (const bad of [
      'acme',
      'acme..com',
      '-acme.com',
      'acme-.com',
      'a b.com',
      '10.0.0.1',
      'acme.com/',
      'https://acme.com',
      `${'a'.repeat(64)}.com`,
    ]) {
      expect(ssoDomainSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('reads PEM or base64 certificates into base64 bodies, up to 3', () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${CERT.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`;
    expect(ssoCertificateSchema.parse(pem)).toBe(CERT);
    expect(ssoCertificateSchema.parse(`${pem}${pem}`)).toBe(`${CERT},${CERT}`);
    expect(ssoCertificateSchema.parse(`  ${CERT}  `)).toBe(CERT);
    expect(ssoCertificateSchema.safeParse(`${pem}${pem}${pem}${pem}`).success).toBe(false);
    expect(ssoCertificateSchema.safeParse('not a certificate').success).toBe(false);
    expect(ssoCertificateSchema.safeParse('').success).toBe(false);
  });

  it('takes an OIDC or a SAML connection with defaults, strictly', () => {
    const oidc = ssoConnectionInputSchema.parse({
      protocol: 'oidc',
      displayName: 'Okta',
      oidc: { issuer: 'https://acme.okta.com', clientId: 'abc' },
    });
    expect(oidc).toMatchObject({
      enabled: true,
      requireSso: false,
      jit: true,
      defaultRole: 'editor',
    });
    const bad = [
      { protocol: 'oidc', displayName: 'x', saml: { entityId: 'e', ssoUrl: 'https://x.test' } },
      { protocol: 'oidc', displayName: 'x', oidc: { issuer: 'ftp://x.test', clientId: 'a' } },
      { protocol: 'oidc', displayName: 'x', oidc: { issuer: 'https://u:p@x.test', clientId: 'a' } },
      {
        protocol: 'oidc',
        displayName: 'x',
        oidc: { issuer: 'https://x.test', clientId: 'a' },
        defaultRole: 'owner',
      },
      {
        protocol: 'oidc',
        displayName: 'x',
        oidc: { issuer: 'https://x.test', clientId: 'a' },
        extra: 1,
      },
      { protocol: 'ldap', displayName: 'x' },
    ];
    for (const b of bad)
      expect(ssoConnectionInputSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    expect(
      ssoConnectionInputSchema.parse({
        protocol: 'saml',
        displayName: 'Entra',
        saml: {
          entityId: 'https://sts.windows.net/x/',
          ssoUrl: 'https://login.microsoftonline.com/x/saml2',
        },
      }).protocol
    ).toBe('saml');
  });

  it('names workspace providers by workspace id', () => {
    expect(ssoAlias('0190a1b2-0000-7000-8000-000000000000')).toBe(
      'ws-0190a1b2-0000-7000-8000-000000000000'
    );
  });
});
