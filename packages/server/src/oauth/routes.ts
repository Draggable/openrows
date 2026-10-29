import { contracts, TOKEN_SCOPES } from '@openrows/shared';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { auditForUser, requestActor } from '../audit/record.js';
import { clientIp } from '../auth/client-ip.js';
import { rateLimit } from '../auth/rate-limit.js';
import type { RouteRegistry } from '../authz/routes.js';
import { inScope } from '../authz/scope.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import {
  authorizeInfo,
  type ClientCredentials,
  createApp,
  decide,
  deleteApp,
  exchangeCode,
  listApps,
  listAuthorizations,
  OAuthError,
  refreshTokens,
  revokeAuthorization,
  revokeByClient,
  updateApp,
} from './service.js';

/** Token and revocation requests per client IP and minute. */
export const OAUTH_TOKEN_IP_LIMIT_PER_MINUTE = 120;
const TOKEN_BODY_LIMIT = 16 * 1024;

export const OAUTH_TOKEN_PATH = '/oauth/token';
export const OAUTH_REVOKE_PATH = '/oauth/revoke';
/** The consent screen: a client route, served as index.html like any other. */
export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';
export const OAUTH_METADATA_PATH = '/.well-known/oauth-authorization-server';

/**
 * OAuth apps. Session routes: the apps you registered (`/api/me/oauth-apps`), the apps
 * you authorized (`/api/me/authorizations`) and the consent screen's check and answer
 * (`/api/oauth/authorize`, the Origin check applies). Public routes for the apps themselves: the
 * token endpoint (authorization code with PKCE, refresh token rotation), revocation (RFC 7009)
 * and the server metadata (RFC 8414), each authenticated by the client's id and secret, never a
 * session, rate-limited per IP.
 */
export function oauthRoutes(routes: RouteRegistry, deps: { db: Database; config: Config }) {
  const { db, config } = deps;
  const a = contracts.oauthApps;
  const z = contracts.oauthAuthorizations;
  const user = (c: { var: { principal: { user: { id: string } } } }) => c.var.principal.user.id;

  routes.endpoint(a.list, 'session', async (c) => {
    const userId = user(c);
    return { apps: await inScope(db, { userId }, (tx) => listApps(tx, userId)) };
  });

  routes.endpoint(a.create, 'session', async (c, { body }) => {
    const userId = user(c);
    const app = await inScope(db, { userId }, (tx) => createApp(tx, userId, body));
    c.var.logger.info({ oauthAppId: app.id }, 'OAuth app registered');
    return app;
  });

  routes.endpoint(a.update, 'session', async (c, { params, body }) => {
    const userId = user(c);
    const app = await inScope(db, { userId }, (tx) => updateApp(tx, userId, params.appId, body));
    if (body.rotateSecret) c.var.logger.info({ oauthAppId: app.id }, 'OAuth app secret rotated');
    return app;
  });

  routes.endpoint(a.delete, 'session', async (c, { params }) => {
    const userId = user(c);
    await inScope(db, { userId }, (tx) => deleteApp(tx, userId, params.appId));
    c.var.logger.info({ oauthAppId: params.appId }, 'OAuth app deleted');
    return null;
  });

  routes.endpoint(z.list, 'session', async (c) => {
    const userId = user(c);
    return {
      authorizations: await inScope(db, { userId }, (tx) => listAuthorizations(tx, userId)),
    };
  });

  routes.endpoint(z.revoke, 'session', async (c, { params }) => {
    const userId = user(c);
    const { appId } = await inScope(db, { userId }, (tx) =>
      revokeAuthorization(tx, userId, params.authorizationId)
    );
    c.var.logger.info({ authorizationId: params.authorizationId, appId }, 'OAuth app revoked');
    await auditForUser(db, c.var.edition.audit, userId, {
      action: 'oauth.revoke',
      actor: requestActor(c),
      target: { type: 'oauth_app', id: appId },
    }).catch((err) => c.var.logger.error({ err }, 'could not audit the revocation'));
    return null;
  });

  routes.endpoint(z.check, 'session', async (c, { query }) => {
    const userId = user(c);
    return inScope(db, { userId }, (tx) => authorizeInfo(tx, userId, query));
  });

  routes.endpoint(z.decide, 'session', async (c, { body }) => {
    const userId = user(c);
    const { redirectTo, authorization } = await inScope(db, { userId }, (tx) =>
      decide(tx, userId, body)
    );
    if (authorization) {
      c.var.logger.info(
        { authorizationId: authorization.id, appId: authorization.appId },
        'OAuth app authorized'
      );
      // Into each of the person's workspaces' audit logs: the app, its scopes and grant sizes.
      await auditForUser(db, c.var.edition.audit, userId, {
        action: 'oauth.authorize',
        actor: requestActor(c),
        target: { type: 'oauth_app', id: authorization.appId, name: authorization.appName },
        summary: {
          after: {
            scopes: body.scope.split(' ').filter(Boolean),
            workspaces: body.workspaceIds.length,
            bases: body.baseIds.length,
          },
        },
      }).catch((err) => c.var.logger.error({ err }, 'could not audit the authorization'));
    }
    return { redirectTo };
  });

  // ---- the apps' endpoints ----

  const ip = (c: Context) =>
    clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops }) ?? 'unknown';
  for (const path of [OAUTH_TOKEN_PATH, OAUTH_REVOKE_PATH]) {
    routes.use(
      path,
      rateLimit({
        limit: OAUTH_TOKEN_IP_LIMIT_PER_MINUTE,
        windowMs: 60_000,
        key: (c) => `oauth-ip:${ip(c)}`,
      })
    );
    routes.use(
      path,
      bodyLimit({
        maxSize: TOKEN_BODY_LIMIT,
        onError: () => {
          throw new AppError('PAYLOAD_TOO_LARGE', { detail: 'The request is too large.' });
        },
      })
    );
  }

  routes.public('POST', OAUTH_TOKEN_PATH, async (c) => {
    noStore(c);
    try {
      const form = await formOf(c);
      const creds = credentialsOf(c, form);
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const code = form.get('code');
        const verifier = form.get('code_verifier');
        if (!code || !verifier) {
          throw new OAuthError('invalid_request', 'code and code_verifier are required.');
        }
        return c.json(
          await exchangeCode(db, creds, {
            code,
            codeVerifier: verifier,
            redirectUri: form.get('redirect_uri') ?? undefined,
          })
        );
      }
      if (grant === 'refresh_token') {
        const token = form.get('refresh_token');
        if (!token) throw new OAuthError('invalid_request', 'refresh_token is required.');
        return c.json(await refreshTokens(db, creds, token));
      }
      throw new OAuthError(
        'unsupported_grant_type',
        'Use grant_type=authorization_code or refresh_token.'
      );
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err);
      throw err;
    }
  });

  routes.public('POST', OAUTH_REVOKE_PATH, async (c) => {
    noStore(c);
    try {
      const form = await formOf(c);
      const creds = credentialsOf(c, form);
      const token = form.get('token');
      if (!token) throw new OAuthError('invalid_request', 'token is required.');
      const revoked = await revokeByClient(db, creds, token);
      if (revoked) {
        c.var.logger.info({ authorizationId: revoked.authorizationId }, 'OAuth app revoked');
        await auditForUser(db, c.var.edition.audit, revoked.userId, {
          action: 'oauth.revoke',
          actor: requestActor(c, null),
          target: { type: 'oauth_app', name: revoked.appName },
        }).catch((err) => c.var.logger.error({ err }, 'could not audit the revocation'));
      }
      return c.body(null, 200);
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(c, err);
      throw err;
    }
  });

  routes.public('GET', OAUTH_METADATA_PATH, (c) =>
    c.json({
      issuer: config.appUrl,
      authorization_endpoint: `${config.appUrl}${OAUTH_AUTHORIZE_PATH}`,
      token_endpoint: `${config.appUrl}${OAUTH_TOKEN_PATH}`,
      revocation_endpoint: `${config.appUrl}${OAUTH_REVOKE_PATH}`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      scopes_supported: TOKEN_SCOPES,
      service_documentation: `${config.appUrl}/docs/api`,
    })
  );
}

function noStore(c: Context) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function oauthError(c: Context, err: OAuthError) {
  if (err.status === 401) c.header('WWW-Authenticate', 'Basic realm="oauth"');
  return c.json({ error: err.error, error_description: err.description }, err.status);
}

/** The form body (`application/x-www-form-urlencoded`, as RFC 6749 says), or a JSON object. */
async function formOf(c: Context): Promise<URLSearchParams> {
  const type = c.req.header('content-type') ?? '';
  const text = await c.req.text();
  if (/^application\/x-www-form-urlencoded\b/i.test(type)) return new URLSearchParams(text);
  if (/^application\/json\b/i.test(type)) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new OAuthError('invalid_request', 'The body is not valid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new OAuthError('invalid_request', 'The body must be an object.');
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string') params.set(k, v);
    return params;
  }
  throw new OAuthError('invalid_request', 'Send the parameters form-encoded.');
}

/** The client's id and secret: HTTP Basic (RFC 6749 §2.3.1) or `client_id`/`client_secret`. */
function credentialsOf(c: Context, form: URLSearchParams): ClientCredentials {
  const header = c.req.header('authorization');
  const basic = header ? /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header) : null;
  if (basic?.[1]) {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new OAuthError('invalid_client', 'Malformed client credentials.');
    try {
      return {
        clientId: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')),
        clientSecret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')),
      };
    } catch {
      throw new OAuthError('invalid_client', 'Malformed client credentials.');
    }
  }
  const clientId = form.get('client_id');
  const clientSecret = form.get('client_secret');
  if (!clientId || !clientSecret) {
    throw new OAuthError('invalid_client', 'Authenticate with the client id and secret.');
  }
  return { clientId, clientSecret };
}
