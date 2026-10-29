import * as oidc from 'openid-client';
import type { OidcConfig } from '../config.js';

/** The ID-token claims OpenRows uses (ADR-006 §4). */
export interface IdentityClaims {
  issuer: string;
  subject: string;
  email: string | undefined;
  emailVerified: boolean;
  name: string | undefined;
  picture: string | undefined;
  /** The provider's session id, for back-channel logout. */
  sid: string | undefined;
  /** When the user last entered their credentials (`auth_time`), for recent-sign-in checks. */
  authTime: Date | undefined;
  /**
   * The Keycloak identity provider the user came through (`identity_provider`, the realm's
   * session note mapper: per-workspace single sign-on). Undefined for a password sign-in.
   */
  identityProvider: string | undefined;
}

export interface TokenSet {
  claims: IdentityClaims;
  idToken: string | undefined;
  refreshToken: string | undefined;
}

/** What the server keeps between /auth/login and /auth/callback (in an encrypted cookie). */
export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

/** The provider rejected a grant (invalid_grant and friends), as opposed to being unreachable. */
export class OidcRejectedError extends Error {
  override name = 'OidcRejectedError';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function identity(claims: oidc.IDToken): IdentityClaims {
  return {
    issuer: claims.iss,
    subject: claims.sub,
    email: str(claims['email'])?.toLowerCase(),
    emailVerified: claims['email_verified'] === true,
    name: str(claims['name']) ?? str(claims['preferred_username']),
    picture: str(claims['picture']),
    sid: str(claims['sid']),
    authTime: typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000) : undefined,
    identityProvider: str(claims['identity_provider']),
  };
}

/**
 * A thin wrapper around openid-client: discovery (lazy, cached, retried after a failure), the
 * authorization URL with PKCE S256 + state + nonce, the code exchange, refresh and RP-initiated
 * logout. Works with Keycloak and any standards-compliant provider.
 */
export class OidcClient {
  #discovered: Promise<oidc.Configuration> | undefined;

  constructor(
    private readonly config: OidcConfig,
    private readonly opts: { redirectUri: string; allowHttp: boolean }
  ) {}

  #configuration(): Promise<oidc.Configuration> {
    if (!this.#discovered) {
      this.#discovered = oidc
        .discovery(
          new URL(this.config.issuerUrl),
          this.config.clientId,
          this.config.clientSecret,
          undefined,
          this.opts.allowHttp ? { execute: [oidc.allowInsecureRequests] } : undefined
        )
        .catch((err: unknown) => {
          this.#discovered = undefined;
          throw err;
        });
    }
    return this.#discovered;
  }

  /**
   * Starts a sign-in. `signup` asks the provider for its registration page (`prompt=create`);
   * `reauth` makes it ask for the credentials again even with a session there (`prompt=login`,
   * `max_age=0`: a fresh `auth_time`, for deleting the account).
   */
  async startLogin(opts: {
    returnTo: string;
    signup?: boolean;
    reauth?: boolean;
    idpHint?: string;
    /** Prefills the address on the provider's page (after home-realm discovery). */
    loginHint?: string;
  }) {
    const config = await this.#configuration();
    const tx: LoginTransaction = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      codeVerifier: oidc.randomPKCECodeVerifier(),
      returnTo: opts.returnTo,
    };
    const params: Record<string, string> = {
      redirect_uri: this.opts.redirectUri,
      scope: this.config.scopes,
      response_type: 'code',
      code_challenge: await oidc.calculatePKCECodeChallenge(tx.codeVerifier),
      code_challenge_method: 'S256',
      state: tx.state,
      nonce: tx.nonce,
    };
    if (opts.signup) params['prompt'] = 'create';
    else if (opts.reauth) {
      params['prompt'] = 'login';
      params['max_age'] = '0';
    }
    // Keycloak skips its own login page and goes straight to that identity provider.
    if (opts.idpHint) params['kc_idp_hint'] = opts.idpHint;
    if (opts.loginHint) params['login_hint'] = opts.loginHint;
    return { url: oidc.buildAuthorizationUrl(config, params), tx };
  }

  /** Exchanges the code. `callbackUrl` is the callback as the browser saw it (APP_URL based). */
  async finishLogin(callbackUrl: URL, tx: LoginTransaction): Promise<TokenSet> {
    const config = await this.#configuration();
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: tx.codeVerifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('the provider returned no ID token');
    return {
      claims: identity(claims),
      idToken: tokens.id_token,
      refreshToken: tokens.refresh_token,
    };
  }

  /** Uses the refresh token. Throws OidcRejectedError when the provider ended the session. */
  async refresh(
    refreshToken: string
  ): Promise<Omit<TokenSet, 'claims'> & { claims?: IdentityClaims }> {
    const config = await this.#configuration();
    try {
      const tokens = await oidc.refreshTokenGrant(config, refreshToken);
      const claims = tokens.claims();
      return {
        claims: claims ? identity(claims) : undefined,
        idToken: tokens.id_token,
        refreshToken: tokens.refresh_token ?? refreshToken,
      };
    } catch (err) {
      if (err instanceof oidc.ResponseBodyError)
        throw new OidcRejectedError(err.error, { cause: err });
      throw err;
    }
  }

  /** The provider's end-session URL, or undefined if it has none. */
  async logoutUrl(opts: { idToken: string | undefined; postLogoutRedirectUri: string }) {
    const config = await this.#configuration();
    if (!config.serverMetadata().end_session_endpoint) return undefined;
    const params: Record<string, string> = {
      post_logout_redirect_uri: opts.postLogoutRedirectUri,
      client_id: this.config.clientId,
    };
    if (opts.idToken) params['id_token_hint'] = opts.idToken;
    return oidc.buildEndSessionUrl(config, params);
  }
}

export { AuthorizationResponseError } from 'openid-client';
