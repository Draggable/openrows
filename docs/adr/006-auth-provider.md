# ADR-006: Authentication through Keycloak via OIDC

- **Status:** Accepted (2026-10-25)
- **Related:** [ADR-002](002-tenancy.md), [ADR-005](005-open-core.md)

## Context

The prototype used better-auth. Its session, account and verification tables were missing from
the schema, so login could never have worked. The maintainers already ran Keycloak in
production for another product. It handles sign-up, email verification, password reset, social login
(Google, GitHub), MFA and, for enterprise customers, SAML/OIDC brokering and SCIM. Running a
second identity system inside OpenRows would duplicate that and put security-critical code in
the app.

## Decision

1. **OpenRows is an OpenID Connect relying party, and nothing more.** The server is a
   confidential client using the Authorization Code flow with PKCE (`openid-client`). It works
   with **Keycloak and any standards-compliant OIDC provider** (Authentik, Zitadel, Auth0,
   Okta and so on). better-auth is gone and won't come back.
2. **Configuration.** All of it comes from env, validated by the Zod config:
   - `OIDC_ISSUER_URL` (discovery via `/.well-known/openid-configuration`);
   - `OIDC_CLIENT_ID`;
   - `OIDC_CLIENT_SECRET`;
   - `APP_URL`, which gives the redirect URI `${APP_URL}/auth/callback`;
   - `OIDC_SCOPES` (default `openid email profile`).

   Production refuses to start without HTTPS URLs and a secret.
3. **Backend-for-frontend sessions.** The server handles `/auth/login`, `/auth/callback`,
   `/auth/logout` and `/auth/backchannel-logout`. After the callback it creates its **own**
   session: a random 256-bit id in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, stored hashed
   in `sessions` with idle and absolute expiry (7 and 30 days). OIDC tokens never reach the
   browser. The refresh token is stored encrypted, so the server can re-check the user and
   honour back-channel logout. HTTP and WebSocket (ADR-003) both authenticate with this cookie.
   State-changing requests check the `Origin` header for CSRF.
4. **Users and identities.** `user_identities(issuer, subject)` maps to a global `users` row.
   On first login we create the user from the `email`, `email_verified`, `name` and `picture`
   claims. An invitation is matched by email only if `email_verified` is true. We store no
   passwords.
5. **Environments.**
   - **Dev:** a Keycloak container in the Compose dev stack, with a realm import (dev users,
     Mailpit for email), so `npm run dev` works offline.
   - **Prod:** realm `openrows` on a production Keycloak, client `openrows-app`, with Google
     and GitHub brokering and email verification and password reset turned on. The realm
     settings are documented in the repo, without secrets.
   - **Self-host:** set `OIDC_ISSUER_URL` to your own Keycloak or another OIDC provider. The
     production Compose file offers an optional bundled Keycloak (`--profile keycloak`) so that a
     fresh install works out of the box.
6. **Machine access isn't Keycloak's job.** Personal access tokens and API keys (M4) are
   issued by OpenRows as opaque, hashed, scoped tokens. Webhooks are signed by OpenRows.
7. **Enterprise SSO and SCIM** (paid, hosted) configure per-workspace identity providers
   through Keycloak's admin API. The core doesn't care, because it keeps trusting one issuer.

## Consequences

- Self-hosters must run, or already have, an OIDC provider. Keycloak needs about 0.5–1 GB of RAM,
  which is heavier than built-in email and password. The bundled profile and docs soften that.
- Sign-up, verification, reset, MFA and social login come from Keycloak and need no app code.
  Theming the Keycloak login pages to match OpenRows is follow-up work.
- Logging out of OpenRows ends the app session and redirects to the provider's end-session
  endpoint. Back-channel logout ends sessions the provider revokes.
- The integration tests run a real Keycloak container (or a minimal OIDC test provider) to
  cover the callback flow.

## Alternatives considered

- **better-auth, or another library embedded in the app** (Auth.js, Lucia). It duplicates
  the existing Keycloak, puts password and MFA handling in our code, and the prototype
  integration was broken anyway. Dropped.
- **Keycloak-specific APIs (admin REST, a custom SPI) in the core.** That would lock
  self-hosters to Keycloak. Plain OIDC keeps the core provider-neutral. Keycloak specifics live
  only in deployment docs and in the hosted edition.

## Implementation notes: OAuth apps (2026-10-29)

Keycloak stays the identity provider for people signing in. For third-party integrations the
OpenRows server is itself a small OAuth 2.0 authorization server ([api/oauth.md](../api/oauth.md)):
apps registered by users, authorization code with PKCE (S256), confidential clients, opaque
hashed tokens (`or_oat_`, `or_ort_`) in Postgres with refresh rotation and replay revocation.
Access tokens are resolved like personal access tokens (the person's live role ∩ scopes ∩
grants), so authorization stays in one place (`authorize()`). Keycloak's own clients weren't used
for this: per-base grants and our scopes would have had to be mirrored into Keycloak, and every
API request would need token introspection against it.
