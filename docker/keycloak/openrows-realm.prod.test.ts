import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The production realm template (a production Keycloak imports it on its first start) against
// the dev realm's contract (openrows-realm.test.ts), and docs/deploy/keycloak.md, which describes
// it.
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
const prod = JSON.parse(
  readFileSync(new URL('./openrows-realm.prod.json', import.meta.url), 'utf8')
) as Realm;
const docs = readFileSync(new URL('../../docs/deploy/keycloak.md', import.meta.url), 'utf8');

describe('docker/keycloak/openrows-realm.prod.json against the dev realm and the docs', () => {
  it('brute-force detection matches the dev realm (#133)', () => {
    const keys = [
      'bruteForceProtected',
      'permanentLockout',
      'maxTemporaryLockouts',
      'failureFactor',
      'waitIncrementSeconds',
      'maxFailureWaitSeconds',
      'quickLoginCheckMilliSeconds',
      'minimumQuickLoginWaitSeconds',
      'maxDeltaTimeSeconds',
    ];
    for (const k of keys) expect(prod[k], k).toEqual(realm[k]);
  });

  it('the prod docs name the same realm, client and production URLs', () => {
    for (const s of [
      'openrows',
      'openrows-app',
      'https://app.openrows.io/auth/callback',
      'https://app.openrows.io/',
      'S256',
      `${realm['ssoSessionIdleTimeout']}`,
      `${realm['ssoSessionMaxLifespan']}`,
    ]) {
      expect(docs).toContain(s);
    }
  });
  it('has the dev realm settings, without its users, client URLs, secret or mail', () => {
    const strip = ({ clients: _c, smtpServer: _s, users: _u, ...rest }: Realm) => rest;
    expect(strip(prod)).toEqual(strip(realm));
    expect(prod['users']).toBeUndefined();
  });

  it('openrows-app: the same client on https://app.openrows.io only, the secret from the env', () => {
    const [devClient] = realm.clients;
    const [client, ...more] = prod.clients;
    expect(more).toEqual([]);
    const perEnv = ['secret', 'rootUrl', 'redirectUris', 'webOrigins', 'attributes', 'description'];
    const rest = (c: Client | undefined) =>
      Object.fromEntries(Object.entries(c ?? {}).filter(([k]) => !perEnv.includes(k)));
    expect(rest(client)).toEqual(rest(devClient));
    expect(client).toMatchObject({
      secret: `\${OIDC_CLIENT_SECRET}`,
      rootUrl: 'https://app.openrows.io',
      redirectUris: ['https://app.openrows.io/auth/callback'],
      webOrigins: ['https://app.openrows.io'],
    });
    expect(client?.attributes).toEqual({
      'pkce.code.challenge.method': 'S256',
      'post.logout.redirect.uris': 'https://app.openrows.io/*',
    });
  });

  it('mail settings come from the env file (an empty host sends nothing)', () => {
    const { fromDisplayName, ...smtp } = prod.smtpServer;
    expect(fromDisplayName).toBe('OpenRows');
    for (const v of Object.values(smtp)) expect(v).toMatch(/^\$\{OPENROWS_KC_SMTP_[A-Z]+:/);
    expect(smtp['from']).toBe(`\${OPENROWS_KC_SMTP_FROM:noreply@openrows.io}`);
  });
});
