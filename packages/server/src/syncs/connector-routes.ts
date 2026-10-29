import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { contracts, downloads } from '@openrows/shared';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { type Cipher, createCipher } from '../auth/crypto.js';
import { safeReturnTo } from '../auth/return-to.js';
import type { RouteRegistry } from '../authz/routes.js';
import { inScope } from '../authz/scope.js';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import {
  disconnectAccount,
  listConnectors,
  type SyncSources,
  saveAccount,
} from './sources/index.js';

/**
 * Sync connector accounts: the signed-in person connects their own account at one of the
 * edition's connectors (OAuth 2 authorization code + PKCE S256, `state` and the verifier in an
 * encrypted, path-scoped HttpOnly cookie, bound to the session's user), lists and disconnects it.
 * Session only. The tokens never leave the server; the provider's answers are never logged.
 */

/** The connect flow's cookie (docs/legal/cookies.md). */
export const SYNC_CONNECT_COOKIE = 'openrows_sync_connect';
const COOKIE_TTL_S = 600;

interface FlowState {
  connector: string;
  userId: string;
  state: string;
  verifier: string;
  returnTo: string;
  iat: number;
}

function readFlow(cipher: Cipher, sealed: string | undefined): FlowState | null {
  if (!sealed) return null;
  const text = cipher.decrypt(Buffer.from(sealed, 'base64url'));
  if (!text) return null;
  try {
    const flow = JSON.parse(text) as Partial<FlowState>;
    if (
      typeof flow.connector !== 'string' ||
      typeof flow.userId !== 'string' ||
      typeof flow.state !== 'string' ||
      typeof flow.verifier !== 'string' ||
      typeof flow.returnTo !== 'string' ||
      typeof flow.iat !== 'number' ||
      Date.now() - flow.iat > COOKIE_TTL_S * 1000
    ) {
      return null;
    }
    return flow as FlowState;
  } catch {
    return null;
  }
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The page to go back to, with the outcome for the "Sync data" dialog. */
function back(returnTo: string, connector: string, connected: boolean): string {
  const url = new URL(returnTo, 'http://openrows.invalid');
  url.searchParams.set('syncConnector', connector);
  url.searchParams.set('connected', connected ? '1' : '0');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function connectorRoutes(
  routes: RouteRegistry,
  deps: { db: Database; appUrl: string; encryptionKey: string; sources: SyncSources | undefined }
) {
  const s = contracts.syncs;
  const secure = deps.appUrl.startsWith('https:');
  const cipher = createCipher(deps.encryptionKey, 'sync-connector-state');
  const cookiePath = '/api/me/sync-connectors';
  const connectors = deps.sources?.connectors;
  const known = (id: string) => {
    const connector = connectors?.connectors.get(id);
    if (!connectors || !connector) {
      throw new AppError('NOT_FOUND', { detail: 'No such sync connector.' });
    }
    return { connector, connectors };
  };
  const redirectUri = (id: string) =>
    new URL(
      downloads.syncConnectorCallback.path.replace(':connectorId', encodeURIComponent(id)),
      deps.appUrl
    ).href;

  routes.endpoint(s.connectors, 'session', async (c) => {
    const userId = c.var.principal.user.id;
    if (!connectors) return { connectors: [] };
    return {
      connectors: await inScope(deps.db, { userId }, (tx) =>
        listConnectors(tx, connectors, userId)
      ),
    };
  });

  routes.endpoint(s.disconnect, 'session', async (c, { params }) => {
    const userId = c.var.principal.user.id;
    const { connectors: all } = known(params.connectorId);
    const removed = await inScope(deps.db, { userId }, (tx) =>
      disconnectAccount(tx, all, userId, params.connectorId)
    );
    if (!removed) throw new AppError('NOT_FOUND', { detail: 'No connected account.' });
    c.var.logger.info({ connector: params.connectorId }, 'sync connector disconnected');
    return null;
  });

  const connect = downloads.syncConnectorConnect;
  routes.session(connect.method, connect.path, async (c) => {
    const id = c.req.param('connectorId') ?? '';
    const { connector } = known(id);
    const query = connect.query.parse(c.req.query());
    const verifier = randomBytes(32).toString('base64url');
    const flow: FlowState = {
      connector: connector.id,
      userId: c.var.principal.user.id,
      state: randomBytes(24).toString('base64url'),
      verifier,
      returnTo: safeReturnTo(query.returnTo),
      iat: Date.now(),
    };
    setCookie(c, SYNC_CONNECT_COOKIE, cipher.encrypt(JSON.stringify(flow)).toString('base64url'), {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: cookiePath,
      maxAge: COOKIE_TTL_S,
    });
    const url = connector.authorizationUrl({
      state: flow.state,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      redirectUri: redirectUri(connector.id),
    });
    return c.redirect(url);
  });

  const callback = downloads.syncConnectorCallback;
  routes.session(callback.method, callback.path, async (c) => {
    const id = c.req.param('connectorId') ?? '';
    const { connector, connectors: all } = known(id);
    const log = c.var.logger;
    const userId = c.var.principal.user.id;
    const flow = readFlow(cipher, getCookie(c, SYNC_CONNECT_COOKIE));
    deleteCookie(c, SYNC_CONNECT_COOKIE, { path: cookiePath, secure, httpOnly: true });
    const parsed = callback.query.safeParse(c.req.query());
    const query = parsed.success ? parsed.data : {};
    if (!flow || flow.connector !== connector.id || flow.userId !== userId) {
      log.warn({ connector: id }, 'sync connector callback without its flow');
      return c.redirect(back('/', connector.id, false));
    }
    if (!query.state || !sameText(query.state, flow.state)) {
      log.warn({ connector: id }, 'sync connector callback with a state that does not match');
      return c.redirect(back(flow.returnTo, connector.id, false));
    }
    if (query.error || !query.code) {
      log.info({ connector: id }, 'sync connector consent declined');
      return c.redirect(back(flow.returnTo, connector.id, false));
    }
    try {
      const ctx = { http: all.http };
      const tokens = await connector.exchangeCode(ctx, {
        code: query.code,
        codeVerifier: flow.verifier,
        redirectUri: redirectUri(connector.id),
      });
      const label = await connector.accountLabel(ctx, tokens.accessToken);
      await inScope(deps.db, { userId }, (tx) =>
        saveAccount(tx, all, { userId, connector: connector.id, label, tokens })
      );
    } catch (err) {
      // The error's name only: a provider's answer can carry tokens.
      log.warn({ connector: id, error: (err as Error).name }, 'sync connector not connected');
      return c.redirect(back(flow.returnTo, connector.id, false));
    }
    log.info({ connector: id }, 'sync connector connected');
    return c.redirect(back(flow.returnTo, connector.id, true));
  });
}
