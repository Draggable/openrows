import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The dev realm export's contract (ADR-006). docs/deploy/keycloak.md describes the same
// settings for a production realm, so keep both in step. The live import is exercised by
// `npm run e2e:auth`.
interface Client {
  clientId: string;
  [k: string]: unknown;
  attributes: Record<string, string>;
}
interface Realm {
  clients: Client[];
  identityProviders: { alias: string; enabled: unknown; config: Record<string, string> }[];
  smtpServer: Record<string, string>;
  [k: string]: unknown;
}

const realm = JSON.parse(
  readFileSync(new URL('./openrows-realm.json', import.meta.url), 'utf8')
) as Realm;

describe('docker/keycloak/openrows-realm.json', () => {
  it('self-registration with email verification, reset, brute-force protection', () => {
    expect(realm).toMatchObject({
      realm: 'openrows',
      enabled: true,
      sslRequired: 'external',
      registrationAllowed: true,
      registrationEmailAsUsername: true,
      verifyEmail: true,
      loginWithEmailAllowed: true,
      duplicateEmailsAllowed: false,
      resetPasswordAllowed: true,
      bruteForceProtected: true,
      permanentLockout: false,
    });
  });

  it('brute-force detection also slows quick retries (#133)', () => {
    const wanted = {
      bruteForceProtected: true,
      permanentLockout: false,
      maxTemporaryLockouts: 0,
      failureFactor: 10,
      waitIncrementSeconds: 60,
      maxFailureWaitSeconds: 900,
      quickLoginCheckMilliSeconds: 1000,
      minimumQuickLoginWaitSeconds: 60,
      maxDeltaTimeSeconds: 43200,
    };
    expect(realm).toMatchObject(wanted);
  });

  it('SSO session lifetimes cover the app session (7 days idle, 30 days max)', () => {
    expect(realm['ssoSessionIdleTimeout']).toBe(7 * 24 * 3600);
    expect(realm['ssoSessionMaxLifespan']).toBe(30 * 24 * 3600);
    // The app's login cookie lives as long as Keycloak's login lifespan (src/auth/routes.ts).
    expect(realm['accessCodeLifespanLogin']).toBe(1800);
    expect(realm).toMatchObject({ revokeRefreshToken: true, refreshTokenMaxReuse: 0 });
  });

  // 5173: Vite (npm run dev), 4173: vite preview (e2e), 8180: the Compose dev stack.
  it('openrows-app is a confidential code + PKCE S256 client for localhost only', () => {
    const app = realm.clients.find((c) => c.clientId === 'openrows-app');
    expect(app).toMatchObject({
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      redirectUris: [
        'http://localhost:5173/auth/callback',
        'http://localhost:4173/auth/callback',
        'http://localhost:8180/auth/callback',
      ],
      webOrigins: ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:8180'],
    });
    expect(app?.attributes['pkce.code.challenge.method']).toBe('S256');
    expect(app?.attributes['post.logout.redirect.uris']).toBe(
      'http://localhost:5173/##http://localhost:4173/##http://localhost:8180/'
    );
    expect(realm.clients).toHaveLength(3);
    // which identity provider the user came through, for per-workspace single sign-on.
    expect(app?.['protocolMappers']).toEqual([
      expect.objectContaining({
        protocolMapper: 'oidc-usersessionmodel-note-mapper',
        config: expect.objectContaining({
          'user.session.note': 'identity_provider',
          'claim.name': 'identity_provider',
          'id.token.claim': 'true',
        }),
      }),
    ]);
  });

  // the api sets up workspaces' identity providers, nothing else.
  it('openrows-sso is a service account that may only manage identity providers', () => {
    const sso = realm.clients.find((c) => c.clientId === 'openrows-sso');
    expect(sso).toMatchObject({
      publicClient: false,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      redirectUris: [],
      webOrigins: [],
    });
    const users = realm['users'] as { serviceAccountClientId?: string; clientRoles?: unknown }[];
    const account = users.find((u) => u.serviceAccountClientId === 'openrows-sso');
    expect(account?.clientRoles).toEqual({ 'realm-management': ['manage-identity-providers'] });
  });

  // the worker deletes purged accounts' users through the admin API, nothing else.
  it('openrows-admin is a service account that may only manage users', () => {
    const admin = realm.clients.find((c) => c.clientId === 'openrows-admin');
    expect(admin).toMatchObject({
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: true,
      redirectUris: [],
      webOrigins: [],
    });
    const users = realm['users'] as { serviceAccountClientId?: string; clientRoles?: unknown }[];
    const account = users.find((u) => u.serviceAccountClientId === 'openrows-admin');
    expect(account?.clientRoles).toEqual({ 'realm-management': ['manage-users'] });
  });

  it('Google and GitHub are present but off unless their env vars enable them', () => {
    for (const idp of realm.identityProviders) {
      const name = idp.alias.toUpperCase();
      expect(idp.enabled).toBe(`\${OPENROWS_${name}_ENABLED:false}`);
      expect(idp.config['clientSecret']).toBe(`\${OPENROWS_${name}_CLIENT_SECRET:}`);
    }
    expect(realm.identityProviders.map((i) => i.alias)).toEqual(['google', 'github']);
  });

  it('uses the openrows sign-in and email theme, which the Compose files mount (#140)', () => {
    expect(realm).toMatchObject({ loginTheme: 'openrows', emailTheme: 'openrows' });
    const theme = new URL('./themes/openrows/', import.meta.url);
    const props = (type: string) =>
      readFileSync(new URL(`${type}/theme.properties`, theme), 'utf8');
    // keycloak.v2's own stylesheet first, then the rose overrides.
    expect(props('login')).toMatch(/^parent=keycloak\.v2$/m);
    expect(props('login')).toMatch(/^styles=css\/styles\.css css\/openrows\.css$/m);
    expect(props('email')).toMatch(/^parent=keycloak$/m);
    const css = readFileSync(new URL('login/resources/css/openrows.css', theme), 'utf8');
    expect(css).toContain('#e22651');
    // No coloured left border on a card (DESIGN.md §7): the accent is the card's top bar.
    expect(css).not.toMatch(/border-left/);
    for (const file of ['../dev.yml']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain(
        './keycloak/themes/openrows:/opt/keycloak/themes/openrows:ro'
      );
    }
  });

  it('dev mail goes to Mailpit', () => {
    expect(realm.smtpServer).toMatchObject({ host: '127.0.0.1', port: '1025' });
  });
});

describe('docker/keycloak/customer-realm.json (dev and CI only, #158)', () => {
  const customer = JSON.parse(
    readFileSync(new URL('./customer-realm.json', import.meta.url), 'utf8')
  ) as Realm;

  it('is a separate realm with an OIDC and a SAML client for the openrows realm’s broker', () => {
    expect(customer['realm']).toBe('customer');
    const broker = 'http://localhost:8080/realms/openrows/broker/*';
    const oidc = customer.clients.find((c) => c.clientId === 'openrows-broker');
    expect(oidc).toMatchObject({ protocol: 'openid-connect', redirectUris: [broker] });
    const saml = customer.clients.find((c) => c['protocol'] === 'saml');
    expect(saml).toMatchObject({
      clientId: 'http://localhost:8080/realms/openrows',
      redirectUris: [broker],
    });
    expect(saml?.attributes).toMatchObject({
      'saml.server.signature': 'true',
      saml_name_id_format: 'email',
    });
  });
});
