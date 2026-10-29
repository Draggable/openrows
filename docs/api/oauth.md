# OAuth apps

Integrations that act for other people (a Zapier or Make app, a SaaS connector) register an
OAuth app instead of asking each person for a personal access token. OpenRows is the
authorization server: OAuth 2.0 authorization code with PKCE (S256, required), confidential
clients only, refresh tokens rotated on every use. The server describes itself at
`GET /.well-known/oauth-authorization-server` (RFC 8414).

## Register an app

Settings → "Developer: OAuth apps" → New app: a name, an optional description and homepage
(people see them on the consent screen), and up to 10 redirect URIs, matched exactly (`https`, or
`http` on `localhost`/`127.0.0.1`, no fragment). The answer shows the client ID
(`or_app_…`) and the client secret (`or_secret_…`) once; keep the secret on your server, and
rotate it from the same dialog if it may have leaked (the old one stops working at once).
Deleting the app ends every person's access to it. A user can register up to 20 apps.

## 1. Send the person to the consent screen

```
GET /oauth/authorize?response_type=code
  &client_id=or_app_…
  &redirect_uri=https://your.app/oauth/callback
  &scope=data.records:read%20data.records:write%20schema.bases:read
  &state=<random, checked on the way back>
  &code_challenge=<base64url(SHA-256(code_verifier))>
  &code_challenge_method=S256
```

`scope` is a space-separated list of the [personal access token scopes](v1.md#authentication)
(at least one). Signed-out people sign in first. The screen shows your app, what it asks for and
where it sends them back, and they pick the workspaces (every current and future base) or single
bases it may reach. An unknown `client_id` or a `redirect_uri` that isn't registered is shown
as an error and never redirected; other mistakes (`response_type`, `scope`, PKCE) come back to
your redirect URI as `error=…&error_description=…&state=…`.

Allowing sends the browser to `redirect_uri?code=…&state=…`; declining to
`redirect_uri?error=access_denied&state=…`. Authorizing the same app again replaces its scopes
and grants.

## 2. Exchange the code

```
POST /oauth/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…
```

(`client_id` and `client_secret` in the body work too.) The code is good once, for 10 minutes,
for the same redirect URI and the verifier of its challenge; a code used twice revokes everything
that authorization gave. The answer:

```json
{
  "access_token": "or_oat_…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "or_ort_…",
  "refresh_expires_in": 5184000,
  "scope": "data.records:read data.records:write schema.bases:read"
}
```

Errors are RFC 6749's: `{ "error": "invalid_grant", "error_description": "…" }` with 400
(`invalid_request`, `invalid_grant`, `unsupported_grant_type`) or 401 (`invalid_client`). The
token endpoint takes 120 requests per minute per IP.

## 3. Call the API

`Authorization: Bearer or_oat_…` works wherever a personal access token does (the REST API v1,
the SDK's `apiKey`, the MCP endpoint), and the same way: the person's live role ∩ the scopes ∩
the workspaces and bases they picked, the same session-only routes refused, the same rate limits
(one bucket per authorization). A suspended account, a workspace whose policy turns tokens off
, a revoked authorization or a deleted app end it at once.

## 4. Refresh

```
POST /oauth/token
grant_type=refresh_token&refresh_token=or_ort_…
```

answers a new access token and a new refresh token (60 days). Each refresh token is used once:
presenting an old one again revokes the authorization (it has leaked), and the person has to
authorize the app again.

## Revocation

People revoke an app in Settings → Integrations. An app revokes a token itself with RFC 7009's
`POST /oauth/revoke` (`token=…`, client authentication as above; always 200): a refresh token
ends the whole authorization, an access token only itself.
