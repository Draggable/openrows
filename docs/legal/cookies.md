# Cookie inventory

Last reviewed October 28, 2026.

Every cookie the hosted Service sets on app.openrows.io and auth.openrows.io. Each one is
strictly necessary: it keeps you signed in, protects the sign-in flow against forgery, or lets
you into a password-protected share link. None is used for analytics, advertising or tracking
across sites, so we don't ask for consent ([Privacy Policy](privacy.md), "Cookies"). The
marketing site, openrows.io, sets no cookies at all.

This file is checked by code: `e2e/cookies.spec.ts` signs in and out through the whole stack and
fails on any cookie whose name isn't in a table below, and
`packages/server/src/lib/cookies.test.ts` fails when the server defines a cookie that isn't
listed. The monthly compliance self-check on the live hosts (`docker/compliance/web.mjs`)
fails on any cookie set outside these tables, and `docker/test/compliance.test.ts` keeps its list
equal to them. Add a row here before adding a cookie.

## app.openrows.io (the OpenRows server)

All are `HttpOnly`, `Secure` and `SameSite=Lax`, so page scripts can't read them and other sites
can't send them along with their requests.

| Name | Purpose | Lifetime | Set when |
| --- | --- | --- | --- |
| `openrows_session` | Your sign-in: an opaque random token (the server stores only its SHA-256) | Up to 30 days, ending after 7 days without use, or when you sign out | You sign in |
| `openrows_login` | The sign-in in progress: the encrypted PKCE verifier, `state` and `nonce` that tie Keycloak's answer to your browser. Path `/auth/callback` only | 30 minutes, deleted when sign-in completes | You start signing in |
| `openrows_share` | You entered the password of a protected share link: a signed proof for that link only (its path is the link's `/api/shared/<token>`) | 12 hours | You unlock a password-protected share link |
| `openrows_sync_connect` | Connecting your account at a sync source (Google Sheets on the hosted service): the encrypted PKCE verifier and `state` that tie the provider's answer to your browser and account. Path `/api/me/sync-connectors` only | 10 minutes, deleted when the connection completes | You connect an account for a synced table |

## auth.openrows.io (Keycloak, the sign-in service)

Keycloak 26 sets these under the realm's path (`/realms/openrows/`). They are `Secure`; the ones
marked JS-readable are read by Keycloak's own sign-in pages, never by OpenRows.

| Name | Purpose | Lifetime | Set when |
| --- | --- | --- | --- |
| `AUTH_SESSION_ID` | The sign-in, sign-up or password reset in progress | Browser session | You open the sign-in page |
| `KC_AUTH_SESSION_HASH` | A hash of `AUTH_SESSION_ID`, so the sign-in page notices a sign-in finished in another tab (JS-readable) | 60 seconds | You open the sign-in page |
| `KC_RESTART` | Lets an expired sign-in page restart the sign-in instead of failing | Browser session | You open the sign-in page |
| `KEYCLOAK_IDENTITY` | Your Keycloak single sign-on session (signed), so signing in again skips the password | Up to 30 days, 7 days idle (the realm's SSO settings) | You sign in |
| `KEYCLOAK_SESSION` | The id of that session, for Keycloak's session checks (JS-readable) | As `KEYCLOAK_IDENTITY` | You sign in |
| `KC_STATE_CHECKER` | Protects Keycloak's account pages against forged requests | Browser session | You open Keycloak's account pages |
| `KEYCLOAK_LOCALE` | The language you picked on the sign-in page | Browser session | You pick a language (only when the realm offers several) |

Keycloak can also set `KEYCLOAK_REMEMBER_ME` (a login hint for "Remember me", off in our realm)
and `WELCOME_STATE_CHECKER` (its welcome page, not reachable on auth.openrows.io); neither is set
for users of the Service. Signing out removes the session cookies.

| Name | Purpose | Lifetime | Set when |
| --- | --- | --- | --- |
| `KEYCLOAK_REMEMBER_ME` | "Remember me" login hint | 1 year | Never (disabled in the realm) |
| `WELCOME_STATE_CHECKER` | Keycloak's welcome page | 5 minutes | Never (the page isn't public) |

## Cloudflare (both hosts)

Both hosts are served through Cloudflare. Its security features can set these cookies to tell
people from bots; they hold no personal profile and aren't shared with other sites
([Cloudflare's cookie list](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/)).

| Name | Purpose | Lifetime | Set when |
| --- | --- | --- | --- |
| `__cf_bm` | Bot management: tells legitimate traffic from bots | 30 minutes | Cloudflare's bot protection sees the request |
| `cf_clearance` | You passed a Cloudflare challenge | Up to the challenge's lifetime (30 minutes by default) | Cloudflare challenged the request |
| `_cfuvid` | Rate limiting per visitor behind a shared IP address | Browser session | Cloudflare's rate limiting applies |

The CAPTCHA on public forms and share-link passwords (Cloudflare Turnstile) runs in a frame from
challenges.cloudflare.com and sets no cookie on our hosts.

## Not cookies, but stored in your browser

The app keeps a few preferences in your browser's local storage, never sent to us: the light or
dark theme, whether the sidebar is collapsed, the last workspace you opened, how the record view
is laid out, the Airtable imports it is watching, and which usage banners you dismissed. Service notice
dismissals are stored on the server with your account.
