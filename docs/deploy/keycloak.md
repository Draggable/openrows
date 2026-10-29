# Keycloak for OpenRows (production)

OpenRows signs users in through OpenID Connect ([ADR-006](../adr/006-auth-provider.md)). This
page describes a production Keycloak (`quay.io/keycloak/keycloak:26.7.4`) for it, with the hosted
service's names as the example: Keycloak public at `https://auth.openrows.io` with the realm
`openrows`, so the issuer is `https://auth.openrows.io/realms/openrows`, and the app at
`https://app.openrows.io`. Use your own hostnames. Self-hosters can run Keycloak this way or point
`OIDC_*` at any OIDC provider with the settings below. This page contains no secrets; those go
into your env file.

The realm is created from [`docker/keycloak/openrows-realm.prod.json`](../../docker/keycloak/openrows-realm.prod.json)
on Keycloak's first start (`--import-realm` skips an existing realm, so later changes are made in
the console or with kcadm, and the file is kept in step). Its client secret and SMTP settings are
`${...}` placeholders filled from the env file. The dev export
[`docker/keycloak/openrows-realm.json`](../../docker/keycloak/openrows-realm.json) has the same
settings with localhost URLs, a dev secret, a dev user and Mailpit. The contract test
(`docker/keycloak/openrows-realm.test.ts`) checks that the two agree, and that this page still
names the realm, the client and the production URLs.

## 1. Realm `openrows`

Create it in the admin console (Create realm, name `openrows`), or with `kcadm.sh create realms`,
then set:

| Setting (admin console) | Realm JSON key | Value |
| --- | --- | --- |
| Display name | `displayName` | `OpenRows` |
| Require SSL | `sslRequired` | `external` |
| Themes | `loginTheme`, `emailTheme` | `openrows` (`docker/keycloak/themes/openrows`, mounted at `/opt/keycloak/themes/openrows`, as `docker/dev.yml` does; Realm settings → Themes) |
| User registration | `registrationAllowed` | on |
| Email as username | `registrationEmailAsUsername` | on |
| Login with email | `loginWithEmailAllowed` | on |
| Duplicate emails | `duplicateEmailsAllowed` | off |
| Verify email | `verifyEmail` | **on**. The app also refuses any sign-in whose ID token has `email_verified` false (claude-review H6) |
| Forgot password | `resetPasswordAllowed` | on |
| Edit username | `editUsernameAllowed` | off |
| Remember me | `rememberMe` | off |
| Password policy | `passwordPolicy` | `length(12) and notUsername and notEmail` |
| Brute force detection | `bruteForceProtected` | on, lockout temporary (`permanentLockout` off), `failureFactor` 10, `waitIncrementSeconds` 60, `maxFailureWaitSeconds` 900, `maxDeltaTimeSeconds` 43200 (failures reset after 12 hours); quick retries (`quickLoginCheckMilliSeconds` 1000) wait `minimumQuickLoginWaitSeconds` 60; `maxTemporaryLockouts` 0 (`docker/keycloak/harden-admin.sh` applies these to the live realm) |
| Per-IP limits | `docker/keycloak/edge.conf` (nginx in front of prod's Keycloak) | registration page and form 10/min (burst 5), other login actions (sign-in, OTP, reset, e-mail actions) 30/min (burst 20); 429 over it |
| User events | `eventsEnabled`, `eventsExpiration` | on, 604800 (7 days), listener `jboss-logging` |

### Sessions and tokens

The app keeps its own session (an opaque cookie; 7 days idle, 30 days absolute) and refreshes
Keycloak's refresh token every 5 minutes while the session is in use. If Keycloak rejects the
refresh (user disabled, session revoked, signed out in Keycloak), the app session ends. So the
Keycloak SSO session must last at least as long as the app session:

| Setting | Realm JSON key | Value |
| --- | --- | --- |
| SSO Session Idle | `ssoSessionIdleTimeout` | `604800` (7 days) |
| SSO Session Max | `ssoSessionMaxLifespan` | `2592000` (30 days) |
| Access Token Lifespan | `accessTokenLifespan` | `300` (5 min; the app doesn't use access tokens) |
| Revoke Refresh Token | `revokeRefreshToken` | on, `refreshTokenMaxReuse` 0 (rotation; the server claims each refresh atomically) |
| Login timeout | `accessCodeLifespanLogin` | `1800` (30 min, the same as the app's login cookie) |

### Email (SMTP)

Realm settings, then Email: Keycloak sends the verification and password-reset mail.

| Setting | Value |
| --- | --- |
| From | `noreply@openrows.io` (the realm file's default, `OPENROWS_KC_SMTP_FROM`), display name `OpenRows`: the same mailbox as the app's mail, which openrows.io's SPF, DKIM and DMARC cover |
| Host, port | your mail relay (or the provider's), usually 587; `OPENROWS_KC_SMTP_*` in the env file |
| Encryption | StartTLS (or SSL on 465) |
| Authentication | on, with the relay's user and password |

The sender's domain needs SPF, DKIM and DMARC records for that relay. Use "Test connection"
in the console before you turn on `verifyEmail`, or new sign-ups get stuck.

### Identity providers (Google, GitHub)

Optional; leave them out until you have the credentials. Both are already in the realm files
(switched off, empty client), so a fresh import has them ready.

| Provider | Alias | Redirect URI to register at the provider | Notes |
| --- | --- | --- | --- |
| Google | `google` | `https://auth.openrows.io/realms/openrows/broker/google/endpoint` | Google Cloud console, OAuth client "Web application", authorized JavaScript origin `https://auth.openrows.io`, consent screen External |
| GitHub | `github` | `https://auth.openrows.io/realms/openrows/broker/github/endpoint` | GitHub OAuth app (Draggable org, "OpenRows"); default scope `user:email` |

Settings for both: display name `Google` / `GitHub`, "Trust email" on (they verify addresses),
sync mode `import`, first-login flow `first broker login` (a new user is created; if a local
account already has that email, Keycloak asks the user to confirm linking and to prove they own
the account first, so an IdP can't take over an existing account).

**Adding or rotating one is one command** on the Docker host, with the provider's client in a
mode-600 env file (`CLIENT_ID=` and `CLIENT_SECRET=`, or `GOOGLE_CLIENT_ID=` / `GITHUB_CLIENT_ID=`
and the matching `_CLIENT_SECRET=`):

```sh
cd /srv/openrows                      # next to the env file; holds keycloak-kcadm.env (client=, secret=)
/path/to/openrows/scripts/keycloak-add-idp.sh google google-oauth.env   # or: github github-oauth.env
```

[`scripts/keycloak-add-idp.sh`](../../scripts/keycloak-add-idp.sh) logs in with kcadm inside the
Keycloak container and creates the provider, or updates it if it exists, with exactly the
settings above. Secrets never go on a command line. It logs in as the master realm's service
account `openrows-kcadm` from `keycloak-kcadm.env` (a master-realm service account with the
realm's admin roles), or, without that file, as the admin in `keycloak-admin.txt`
(which fails once that admin has OTP or a pending required action). `KC_CONTAINER`, `KC_REALM`,
`KC_KCADM_FILE` and `KC_ADMIN_FILE` override the defaults (`openrows-prod-keycloak-1`,
`openrows`, the files next to the env file); `IDP_ENABLED=false` adds it switched off.

Then show the button: add the alias to `AUTH_PROVIDERS` in the app's env file (comma-separated,
in button order, e.g. `AUTH_PROVIDERS=github,google`) and restart the api. The sign-in page asks `GET /auth/providers` which buttons to show;
each is a link to `/auth/login?provider=<alias>`, which the server turns into Keycloak's
`kc_idp_hint=<alias>`, so users go straight to GitHub or Google. Aliases not in `AUTH_PROVIDERS`
are ignored there. Self-hosters with another OIDC provider can leave `AUTH_PROVIDERS` empty (only
"Sign in"), or list aliases if their provider understands `kc_idp_hint`. Keycloak's own login page
(the plain "Sign in") also lists every enabled provider by itself.

In the dev realm the same two providers exist but are off unless
`OPENROWS_GOOGLE_ENABLED` / `OPENROWS_GITHUB_ENABLED` and their client id and secret are set for
`docker/compose.sh dev` (via `docker/.env.dev`), with `AUTH_PROVIDERS` set for the server.

Live on app.openrows.io: `github` (since 2026-10-25). `google` is waiting for its OAuth client.

## 2. Client `openrows-app`

Clients, then Create client:

| Setting | Value |
| --- | --- |
| Client type | OpenID Connect |
| Client ID | `openrows-app` |
| Client authentication | **on** (confidential; the OpenRows server is the client, backend-for-frontend) |
| Authentication flow | Standard flow only. Implicit, direct access grants, service accounts, device and CIBA off |
| PKCE method | `S256` (Advanced, "Proof Key for Code Exchange Code Challenge Method") |
| Root URL | `https://app.openrows.io` |
| Home URL | `https://app.openrows.io/` |
| Valid redirect URIs | `https://app.openrows.io/auth/callback` (exactly this, no wildcard) |
| Valid post logout redirect URIs | `https://app.openrows.io/*` (covers `https://app.openrows.io/`) |
| Web origins | `https://app.openrows.io` |
| Front channel logout | off |
| Client scopes | the defaults (`openid`, `email`, `profile`) |
| Mapper `identity provider` | Client scopes → `openrows-app-dedicated` → Add mapper → By configuration → **User Session Note**: name `identity provider`, user session note `identity_provider`, token claim name `identity_provider`, type String, **Add to ID token** on (access token, userinfo and introspection off). The callback reads it to know a sign-in came through a workspace's single sign-on |

Then Credentials: copy the client secret into the app's `OIDC_CLIENT_SECRET`. Rotating it
there and restarting the server is all a rotation takes.

### Client `openrows-admin` (deleting accounts)

The worker deletes a purged account's Keycloak user (`DELETE /admin/realms/openrows/users/<id>`)
as a service account that may only manage users. In the admin console: Clients, Create client,
Client ID `openrows-admin`, Client authentication **on**, Authentication flow: **Service accounts
roles only** (standard flow, direct access grants and the rest off), no URLs. Then Service account
roles, Assign role, filter by clients: `realm-management` → `manage-users` (only that). Copy
Credentials → Client secret into `OIDC_ADMIN_CLIENT_SECRET` (and `OIDC_ADMIN_CLIENT_ID=openrows-admin`)
in the env file; the worker reads them with `OIDC_ISSUER_URL`. With kcadm (inside the keycloak
container, after `kcadm.sh config credentials`):

```sh
kcadm.sh create clients -r openrows -s clientId=openrows-admin -s publicClient=false \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=true
kcadm.sh add-roles -r openrows --uusername service-account-openrows-admin \
  --cclientid realm-management --rolename manage-users
kcadm.sh get clients -r openrows -q clientId=openrows-admin --fields id   # then:
kcadm.sh get clients/<id>/client-secret -r openrows
```

The dev realm export has this client (secret `openrows-dev-admin-secret`); the prod realm file
doesn't (it is only imported on a first start), so production gets it by hand once.

### Client `openrows-sso` (workspace single sign-on)

The api creates, changes and removes workspaces' identity providers
(`/admin/realms/openrows/identity-provider/instances/ws-<workspace id>`, and their mappers) as a
service account that may only manage identity providers. Same steps as `openrows-admin`, with
Client ID `openrows-sso` and the role `realm-management` → `manage-identity-providers` (only
that; it includes viewing them). Its secret goes into the **api's** `OIDC_SSO_CLIENT_SECRET`
(and `OIDC_SSO_CLIENT_ID=openrows-sso`); unset, single sign-on can't be set up (its routes
answer 503 on changes, the settings page says so). With kcadm:

```sh
kcadm.sh create clients -r openrows -s clientId=openrows-sso -s publicClient=false \
  -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=true
kcadm.sh add-roles -r openrows --uusername service-account-openrows-sso \
  --cclientid realm-management --rolename manage-identity-providers
kcadm.sh get clients -r openrows -q clientId=openrows-sso --fields id   # then:
kcadm.sh get clients/<id>/client-secret -r openrows
# The identity_provider claim on openrows-app (step 2's mapper):
kcadm.sh create clients/<openrows-app id>/protocol-mappers/models -r openrows \
  -s name='identity provider' -s protocol=openid-connect \
  -s protocolMapper=oidc-usersessionmodel-note-mapper \
  -s 'config."user.session.note"=identity_provider' -s 'config."claim.name"=identity_provider' \
  -s 'config."jsonType.label"=String' -s 'config."id.token.claim"=true' \
  -s 'config."access.token.claim"=false' -s 'config."userinfo.token.claim"=false'
```

The dev realm export has both (secret `openrows-dev-sso-secret`); the prod realm file has the
mapper but not the client, and the live realm gets both by hand once (it isn't re-imported).
**Add the mapper before setting `OIDC_SSO_CLIENT_*`:** without the `identity_provider` claim the
callback can't tell a workspace provider's sign-in from any other, so it couldn't hold the
provider to its verified domains.

## Single sign-on per workspace

Hosted Business and Enterprise workspaces connect their own SAML 2.0 or OpenID Connect identity
provider (Okta, Microsoft Entra ID, Google Workspace, another Keycloak...). OpenRows doesn't
speak SAML itself: each connection is a Keycloak identity provider in realm `openrows`
(**brokering**), and the app keeps signing in through `openrows-app` as before. Self-hosted
servers add identity providers to their Keycloak directly (Identity providers above).

**How a sign-in goes.**
1. The owner saves the provider on `/w/<id>/sso`. The api reads an OIDC issuer's discovery
   document through the SSRF-safe client (the endpoints must pass the outbound rules, https
   in production), checks a SAML certificate parses, stores what isn't secret
   (`workspace_sso_connections`) and creates or updates the Keycloak provider `ws-<workspace id>`
   in the same request (Keycloak's refusal rolls the change back). The OIDC client secret goes to
   Keycloak only. Providers are hidden on Keycloak's page (`hideOnLogin`), trust the provider's
   address (`trustEmail`), sync it on every sign-in (`syncMode` FORCE) and use the realm's
   `first broker login` flow; OIDC ones use PKCE S256 and the JWKS; SAML ones validate the
   signature, ask for an `emailAddress` NameID and map the `email`, `firstName` and `lastName`
   attributes.
2. The owner adds email domains; each counts once its TXT record
   `_openrows-verification.<domain>` = `openrows-verification=<token>` is found (the system
   resolvers, from the api). Only one workspace may have a domain verified (a unique index).
3. "Sign in with SSO" on `/login` goes to `/auth/login?email=<address>`: the SECURITY DEFINER
   `sso_resolve_domain` finds the verified domain's provider (while the workspace's plan has
   `sso`) and the server sends `kc_idp_hint=ws-<id>` and `login_hint`, so Keycloak goes straight
   to the customer's provider. No provider: `/login?error=sso_not_found`.
4. The callback reads `identity_provider` from the ID token (the mapper above). Through a
   workspace provider, the address must be on one of **its** verified domains (else
   `sso_domain_mismatch`: an owner's provider can't vouch for other people's addresses), and
   with JIT on the person joins the workspace with the default role (never owner; skipped when
   the plan has no editor seat left), audited as `member.sso_join`. Any other sign-in (password,
   Google, GitHub) of an address whose verified domain has "require SSO" is refused
   (`sso_required`), except for that workspace's owners, so a broken provider can't lock them out.

**The customer's side** (shown on the settings page): OIDC redirect URI
`https://auth.openrows.io/realms/openrows/broker/ws-<workspace id>/endpoint`; SAML entity ID
(audience) `https://auth.openrows.io/realms/openrows`, ACS URL the same broker endpoint, and the
metadata at `.../endpoint/descriptor`.

**Dev and CI.** `docker/dev.yml` also imports [`docker/keycloak/customer-realm.json`](../../docker/keycloak/customer-realm.json),
realm `customer` in the same Keycloak, as a customer's provider: the OIDC client
`openrows-broker` (secret `customer-dev-broker-secret`), the SAML client
`http://localhost:8080/realms/openrows` and the user `alice@customer.test` /
`customer-dev-password`. Issuer `http://localhost:8080/realms/customer`, SSO URL
`http://localhost:8080/realms/customer/protocol/saml`, the certificate from
`http://localhost:8080/realms/customer/protocol/saml/descriptor`. The dev api's outbound rules
allow `localhost:8080` for the discovery. `e2e/sso.spec.ts` (stack) runs both protocols through
it, a domain of its own per run marked verified in the database as DNS would.

**Checking it against Okta** (the epic's manual check; not run yet, record the date and result
here when it is):
1. Okta developer org → Applications → Create App Integration → **OIDC, Web Application**:
   sign-in redirect URI = the page's redirect URI, grant type Authorization Code, assignments to
   a test user. On OpenRows: issuer `https://<org>.okta.com`, the client ID and secret. Add the
   org's email domain, put the TXT record in DNS, Verify.
2. Sign out, "Sign in with SSO" with the test user's address: Okta's page, then back signed in;
   the workspace lists the user with the default role; the audit log shows `sso_domain.verify`,
   `sso.update`, `member.sso_join` and `auth.sign_in` with method `sso`.
3. Turn "require SSO" on and sign in with a password account of the same domain:
   `sso_required`. As the workspace's owner: still allowed.
4. **SAML**: Create App Integration → **SAML 2.0**: Single sign-on URL = the ACS URL, Audience
   URI = the entity ID, Name ID format EmailAddress, Application username Email, attribute
   statements `email` = `user.email`, `firstName` = `user.firstName`, `lastName` =
   `user.lastName`. On OpenRows switch to SAML 2.0: the IdP issuer (entity ID), the SSO URL and
   the X.509 certificate from Okta's "View SAML setup instructions". Repeat 2.
5. A user whose Okta address is on another domain: refused with `sso_domain_mismatch`.

**Troubleshooting.** The api logs `single sign-on: Keycloak refused the change` with Keycloak's
status (never the secret); 503 on save means the service account or its role is missing.
`login_failed` after the provider: Keycloak's events (Realm settings → Events, `IDENTITY_PROVIDER_*`
errors), usually a wrong client secret, redirect URI or SAML certificate. Removing a connection
removes the Keycloak provider (and its users' links to it; their accounts stay).

**Known limits.** One provider per workspace; no SAML metadata import (paste the three values);
no IdP-initiated SAML; no single logout to the customer's provider; DNS rebinding between the
discovery check and Keycloak's own calls isn't covered (Keycloak calls the token and JWKS
endpoints itself); a Keycloak SSO session that started another way (password) is reused by
`kc_idp_hint` until it ends, so "require SSO" refuses it until the person signs out; Keycloak
creates its own user for a provider's address before OpenRows refuses a mismatch (the account
can't sign in to OpenRows through that provider).

## 3. The app's environment

The server refuses to start in production if any of these is missing, a placeholder, or not
https (`packages/server/src/config.ts`):

| Variable | Value |
| --- | --- |
| `APP_URL` | `https://app.openrows.io` (the redirect URI becomes `${APP_URL}/auth/callback`) |
| `OIDC_ISSUER_URL` | `https://auth.openrows.io/realms/openrows` |
| `OIDC_CLIENT_ID` | `openrows-app` |
| `OIDC_CLIENT_SECRET` | the client secret from step 2 |
| `OIDC_SCOPES` | leave unset (`openid email profile`) |
| `ENCRYPTION_KEY` | `openssl rand -base64 32`; encrypts the stored refresh and ID tokens and the login cookie. Changing it signs everyone out |
| `TRUST_PROXY` | `true` (the app sits behind a proxy) |
| `TRUST_PROXY_HOPS` | how many proxies append to `X-Forwarded-For`. Behind Cloudflare with a tunnel straight to the app (no other proxy): `1` |
| `AUTH_RATE_LIMIT` | optional, requests per minute per client IP on `/auth/*` (default 30) |
| `AUTH_PROVIDERS` | optional, the "Continue with" buttons: identity-provider aliases, e.g. `github,google` (see Identity providers above) |
| `OIDC_SSO_CLIENT_ID`, `OIDC_SSO_CLIENT_SECRET` | the hosted edition's workspace single sign-on: `openrows-sso` and its secret (the client above). Unset: workspaces can't connect a provider |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | the app's own mail (invitations, notifications, digests, notices): the same relay as above, as `noreply@openrows.io`, `SMTP_SECURE=starttls` |

## 4. Check it

```sh
# The issuer must match OIDC_ISSUER_URL exactly.
curl -s https://auth.openrows.io/realms/openrows/.well-known/openid-configuration | jq -r .issuer
# Sign-in is wired: 302 to Keycloak with code_challenge_method=S256.
curl -sI https://app.openrows.io/auth/login | grep -i '^location'
```

Then sign up with a new address in a private window. The verification mail should arrive, the
link should lead back to `https://app.openrows.io/` signed in, and Sign out should end at the
sign-in page.
