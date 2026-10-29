import { KEYCLOAK_URL, MAILPIT_URL } from './env.js';

/** Fails fast, with the command to run, when the dev Keycloak or Mailpit isn't up. */
export default async function globalSetup() {
  for (const [name, url] of [
    ['Keycloak', `${KEYCLOAK_URL}/realms/openrows/.well-known/openid-configuration`],
    ['Mailpit', `${MAILPIT_URL}/api/v1/info`],
  ] as const) {
    const ok = await fetch(url).then(
      (r) => r.ok,
      () => false
    );
    if (!ok) {
      throw new Error(
        `${name} is not reachable at ${url}. Start it with: docker/compose.sh dev up -d --wait`
      );
    }
  }
}
