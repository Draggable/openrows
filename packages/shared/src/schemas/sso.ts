import { z } from 'zod';

/**
 * Per-workspace single sign-on: a workspace's owners connect their organization's SAML or
 * OIDC identity provider, which OpenRows sets up as a Keycloak identity provider (brokering), and
 * verify the email domains it vouches for with a DNS TXT record. People whose address is on a
 * verified domain find it from the sign-in page ("Sign in with SSO"), join the workspace on
 * their first sign-in through it (JIT) with the default role, and with "require SSO" can't sign
 * in any other way. Only the hosted edition serves it, on plans with `sso`.
 */

export const SSO_PROTOCOLS = ['oidc', 'saml'] as const;
export type SsoProtocol = (typeof SSO_PROTOCOLS)[number];

/** The roles people get when they join through single sign-on: never owner. */
export const SSO_JIT_ROLES = ['creator', 'editor', 'commenter', 'read_only'] as const;
export type SsoJitRole = (typeof SSO_JIT_ROLES)[number];

/** At most this many email domains per workspace. */
export const SSO_DOMAINS_MAX = 10;

/** The TXT record that proves a domain: at this name, with this value. */
export const SSO_TXT_PREFIX = '_openrows-verification';
export const SSO_TXT_VALUE_PREFIX = 'openrows-verification=';

/** A workspace's identity provider alias in Keycloak: stable, so its URLs show before saving. */
export function ssoAlias(workspaceId: string): string {
  return `ws-${workspaceId}`;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A registrable-looking host name: two labels at least, letters, digits and hyphens. */
export const ssoDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((d) => {
    const labels = d.split('.');
    return (
      labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels.at(-1) ?? '')
    );
  }, 'a domain name like example.com');

const url = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .refine((u) => !new URL(u).username && !new URL(u).password, 'a URL without credentials');

/**
 * A PEM certificate or its base64 body; stored and sent to Keycloak as the base64 body only
 * (whitespace and the BEGIN/END lines removed). At most 3 certificates (rotation), comma-separated.
 */
export const ssoCertificateSchema = z
  .string()
  .max(20_000)
  .transform((v) =>
    v
      .split(/-----END CERTIFICATE-----|,/)
      .map((c) => c.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/\s+/g, ''))
      .filter((c) => c !== '')
      .join(',')
  )
  .refine((v) => {
    const certs = v.split(',');
    return (
      v !== '' &&
      certs.length <= 3 &&
      certs.every((c) => c.length >= 200 && /^[A-Za-z0-9+/]+={0,2}$/.test(c))
    );
  }, 'an X.509 certificate (PEM or base64)');

export const ssoOidcInputSchema = z.strictObject({
  /** The provider's issuer; its `/.well-known/openid-configuration` is read when saved. */
  issuer: url,
  clientId: z.string().trim().min(1).max(200),
  /** Required for a new connection; left out to keep the stored one. Never returned. */
  clientSecret: z.string().min(1).max(500).optional(),
});

export const ssoSamlInputSchema = z.strictObject({
  /** The identity provider's entity id (its SAML issuer). */
  entityId: z.string().trim().min(1).max(500),
  /** Its single sign-on service URL (HTTP-Redirect or POST binding). */
  ssoUrl: url,
  /** Required for a new SAML connection; left out to keep the stored one. */
  signingCertificate: ssoCertificateSchema.optional(),
});

const common = {
  displayName: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  /** Members of the verified domains may sign in only through this provider. */
  requireSso: z.boolean().default(false),
  /** People of the verified domains join the workspace on their first sign-in (JIT). */
  jit: z.boolean().default(true),
  defaultRole: z.enum(SSO_JIT_ROLES).default('editor'),
};

export const ssoConnectionInputSchema = z.discriminatedUnion('protocol', [
  z.strictObject({ protocol: z.literal('oidc'), ...common, oidc: ssoOidcInputSchema }),
  z.strictObject({ protocol: z.literal('saml'), ...common, saml: ssoSamlInputSchema }),
]);
export type SsoConnectionInput = z.infer<typeof ssoConnectionInputSchema>;

const timestamp = z.iso.datetime({ offset: true });

export const SsoConnectionSchema = z.object({
  alias: z.string(),
  protocol: z.enum(SSO_PROTOCOLS),
  displayName: z.string(),
  enabled: z.boolean(),
  requireSso: z.boolean(),
  jit: z.boolean(),
  defaultRole: z.enum(SSO_JIT_ROLES),
  oidc: z.object({ issuer: z.string(), clientId: z.string() }).nullable(),
  saml: z
    .object({
      entityId: z.string(),
      ssoUrl: z.string(),
      /** SHA-256 fingerprints of the signing certificates, for people to compare. */
      certificateFingerprints: z.array(z.string()),
    })
    .nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SsoConnection = z.infer<typeof SsoConnectionSchema>;

export const SsoDomainSchema = z.object({
  id: z.uuid(),
  domain: z.string(),
  verifiedAt: timestamp.nullable(),
  lastCheckedAt: timestamp.nullable(),
  /** The TXT record to add: its name and value. */
  txtName: z.string(),
  txtValue: z.string(),
});
export type SsoDomain = z.infer<typeof SsoDomainSchema>;

export const SsoStateSchema = z.object({
  /** Whether this server can set up identity providers (its Keycloak admin client). */
  available: z.boolean(),
  connection: SsoConnectionSchema.nullable(),
  domains: z.array(SsoDomainSchema),
  /** What the identity provider's admin enters on their side. */
  serviceProvider: z.object({
    /** OIDC: the redirect URI to allow. */
    redirectUri: z.string(),
    /** SAML: the service provider's entity id, its ACS URL and its metadata. */
    entityId: z.string(),
    acsUrl: z.string(),
    metadataUrl: z.string(),
  }),
});
export type SsoState = z.infer<typeof SsoStateSchema>;

export const ssoDomainInputSchema = z.strictObject({ domain: ssoDomainSchema });
