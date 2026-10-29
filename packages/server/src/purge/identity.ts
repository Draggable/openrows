import * as oidc from 'openid-client';

/** Deletes users at the identity provider when their OpenRows account is purged. */
export interface IdentityAdmin {
  /**
   * Deletes the user with this (issuer, subject). A user the provider no longer has is fine;
   * users of another issuer (a provider switched since) are left alone. Throws when the provider
   * can't be reached or refuses, so the purge is retried.
   */
  deleteUser(issuer: string, subject: string): Promise<'deleted' | 'absent' | 'other-issuer'>;
}

export interface KeycloakAdminConfig {
  /** The realm's issuer URL, `https://auth.example.com/realms/<realm>` (OIDC_ISSUER_URL). */
  issuerUrl: string;
  /** A confidential client whose service account has realm-management's `manage-users`. */
  clientId: string;
  clientSecret: string;
  allowHttp: boolean;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Keycloak's admin REST API, as a service-account client (client credentials grant through
 * openid-client, so tokens and requests go the way the sign-in flow's do):
 * `DELETE /admin/realms/<realm>/users/<subject>` (Keycloak's subject is its user id).
 */
export function keycloakAdmin(config: KeycloakAdminConfig): IdentityAdmin {
  const issuer = trimSlash(config.issuerUrl);
  const admin = issuer.replace(/\/realms\/([^/]+)$/, '/admin/realms/$1');
  if (admin === issuer) {
    throw new Error('OIDC_ISSUER_URL is not a Keycloak realm URL (…/realms/<realm>)');
  }
  let discovered: Promise<oidc.Configuration> | undefined;
  const configuration = () => {
    discovered ??= oidc
      .discovery(
        new URL(issuer),
        config.clientId,
        config.clientSecret,
        undefined,
        config.allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined
      )
      .catch((err: unknown) => {
        discovered = undefined;
        throw err;
      });
    return discovered;
  };
  return {
    async deleteUser(userIssuer, subject) {
      if (trimSlash(userIssuer) !== issuer) return 'other-issuer';
      const c = await configuration();
      const { access_token: token } = await oidc.clientCredentialsGrant(c);
      const url = new URL(`${admin}/users/${encodeURIComponent(subject)}`);
      const res = await oidc.fetchProtectedResource(c, token, url, 'DELETE');
      await res.body?.cancel();
      if (res.status === 404) return 'absent';
      if (!res.ok) throw new Error(`the identity provider refused the deletion (${res.status})`);
      return 'deleted';
    },
  };
}
