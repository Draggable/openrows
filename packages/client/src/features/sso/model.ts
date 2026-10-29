import type { SsoConnection, SsoConnectionInput, SsoJitRole, SsoProtocol } from '@openrows/shared';
import { ApiError } from '../../api/client';

/** What the single sign-on form edits; secrets start empty and stay write-only. */
export interface SsoForm {
  protocol: SsoProtocol;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  entityId: string;
  ssoUrl: string;
  certificate: string;
  enabled: boolean;
  requireSso: boolean;
  jit: boolean;
  defaultRole: SsoJitRole;
}

export const ROLE_LABELS: Record<SsoJitRole, string> = {
  creator: 'Creator',
  editor: 'Editor',
  commenter: 'Commenter',
  read_only: 'Read only',
};

export const PROTOCOL_LABELS: Record<SsoProtocol, string> = {
  oidc: 'OpenID Connect',
  saml: 'SAML 2.0',
};

export function formFrom(connection: SsoConnection | null): SsoForm {
  return {
    protocol: connection?.protocol ?? 'oidc',
    displayName: connection?.displayName ?? '',
    issuer: connection?.oidc?.issuer ?? '',
    clientId: connection?.oidc?.clientId ?? '',
    clientSecret: '',
    entityId: connection?.saml?.entityId ?? '',
    ssoUrl: connection?.saml?.ssoUrl ?? '',
    // The stored certificate isn't sent back (its fingerprint is): empty keeps it.
    certificate: '',
    enabled: connection?.enabled ?? true,
    requireSso: connection?.requireSso ?? false,
    jit: connection?.jit ?? true,
    defaultRole: connection?.defaultRole ?? 'editor',
  };
}

/** The PUT body for the form. */
export function inputFrom(form: SsoForm): SsoConnectionInput {
  const common = {
    displayName: form.displayName.trim(),
    enabled: form.enabled,
    requireSso: form.requireSso,
    jit: form.jit,
    defaultRole: form.defaultRole,
  };
  if (form.protocol === 'oidc') {
    return {
      protocol: 'oidc',
      ...common,
      oidc: {
        issuer: form.issuer.trim(),
        clientId: form.clientId.trim(),
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
      },
    };
  }
  return {
    protocol: 'saml',
    ...common,
    saml: {
      entityId: form.entityId.trim(),
      ssoUrl: form.ssoUrl.trim(),
      ...(form.certificate.trim() ? { signingCertificate: form.certificate } : {}),
    },
  };
}

export type SsoUnavailable = 'edition' | 'plan' | 'error';

export function ssoUnavailable(err: unknown): SsoUnavailable {
  if (err instanceof ApiError && err.status === 404) return 'edition';
  if (err instanceof ApiError && err.code === 'PLAN_FEATURE_REQUIRED') return 'plan';
  return 'error';
}

/** The API's message (422 details name the field), or the fallback. */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}
