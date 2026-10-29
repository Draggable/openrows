import {
  type createOAuthAppSchema,
  MAX_OAUTH_APPS_PER_USER,
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_CODE_TTL_SECONDS,
  OAUTH_PKCE_CHALLENGE,
  OAUTH_REFRESH_TOKEN_TTL_DAYS,
  type OAuthApp,
  type OAuthAppWithSecret,
  type OAuthAuthorization,
  type OAuthAuthorizeInfo,
  type OAuthAuthorizeQuery,
  type oauthAuthorizeDecisionSchema,
  parseOAuthScope,
  TOKEN_SCOPES,
  type TokenScope,
  type updateOAuthAppSchema,
} from '@openrows/shared';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Principal } from '../auth/sessions.js';
import { inScope } from '../authz/scope.js';
import type { Database, Transaction } from '../db/index.js';
import { oauthApps, oauthAuthorizations, oauthCodes, oauthTokens, users } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { assertGrantable } from '../tokens/service.js';
import {
  clientSecretHash,
  codeHash,
  generateClientId,
  generateClientSecret,
  generateCode,
  generateOAuthToken,
  type OAuthTokenKind,
  parseOAuthToken,
  pkceMatches,
  sameHash,
} from './secrets.js';

/**
 * OAuth apps: registration (the owner's, in their user scope), consent (the person's,
 * in theirs) and the token endpoint, which knows nobody until a lookup function names the user;
 * every write after that runs in that user's scope.
 */

type AppRow = typeof oauthApps.$inferSelect;
type Db = Database | Transaction;
const DAY_MS = 24 * 60 * 60 * 1000;

function toApp(row: AppRow): OAuthApp {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    homepageUrl: row.homepageUrl,
    clientId: row.clientId,
    redirectUris: row.redirectUris,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const knownScopes = (scopes: readonly string[]): TokenScope[] => {
  const known: readonly string[] = TOKEN_SCOPES;
  return scopes.filter((s): s is TokenScope => known.includes(s));
};

// ---- registration (the app's owner) ----

export async function listApps(tx: Transaction, userId: string): Promise<OAuthApp[]> {
  const rows = await tx
    .select()
    .from(oauthApps)
    .where(and(eq(oauthApps.ownerId, userId), isNull(oauthApps.deletedAt)))
    .orderBy(desc(oauthApps.createdAt));
  return rows.map(toApp);
}

export async function createApp(
  tx: Transaction,
  userId: string,
  input: z.output<typeof createOAuthAppSchema>
): Promise<OAuthAppWithSecret> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth-apps:${userId}`}, 0))`
  );
  const [live] = await tx
    .select({ n: count() })
    .from(oauthApps)
    .where(and(eq(oauthApps.ownerId, userId), isNull(oauthApps.deletedAt)));
  if ((live?.n ?? 0) >= MAX_OAUTH_APPS_PER_USER) {
    throw new AppError('CONFLICT', {
      detail: `You can register at most ${MAX_OAUTH_APPS_PER_USER} OAuth apps. Delete one first.`,
    });
  }
  const { secret, hash } = generateClientSecret();
  const [row] = await tx
    .insert(oauthApps)
    .values({
      id: uuidv7(),
      ownerId: userId,
      name: input.name,
      description: input.description,
      homepageUrl: input.homepageUrl,
      clientId: generateClientId(),
      secretHash: hash,
      redirectUris: input.redirectUris,
    })
    .returning();
  if (!row) throw new Error('createApp: no row returned');
  return { ...toApp(row), clientSecret: secret };
}

async function ownApp(tx: Transaction, userId: string, appId: string): Promise<AppRow> {
  const [row] = await tx
    .select()
    .from(oauthApps)
    .where(
      and(eq(oauthApps.id, appId), eq(oauthApps.ownerId, userId), isNull(oauthApps.deletedAt))
    );
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such OAuth app.' });
  return row;
}

export async function updateApp(
  tx: Transaction,
  userId: string,
  appId: string,
  input: z.output<typeof updateOAuthAppSchema>
): Promise<OAuthAppWithSecret> {
  const row = await ownApp(tx, userId, appId);
  const rotated = input.rotateSecret ? generateClientSecret() : null;
  const [updated] = await tx
    .update(oauthApps)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.homepageUrl !== undefined ? { homepageUrl: input.homepageUrl } : {}),
      ...(input.redirectUris !== undefined ? { redirectUris: input.redirectUris } : {}),
      ...(rotated ? { secretHash: rotated.hash } : {}),
      updatedAt: new Date(),
    })
    .where(eq(oauthApps.id, row.id))
    .returning();
  if (!updated) throw new Error('updateApp: no row returned');
  return { ...toApp(updated), clientSecret: rotated?.secret ?? null };
}

/** Deletes an app: its client id stops resolving, so every authorization and token of it ends. */
export async function deleteApp(tx: Transaction, userId: string, appId: string): Promise<AppRow> {
  const row = await ownApp(tx, userId, appId);
  await tx
    .update(oauthApps)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(oauthApps.id, row.id));
  return row;
}

// ---- authorizations (the person who consented) ----

export async function listAuthorizations(
  tx: Transaction,
  userId: string
): Promise<OAuthAuthorization[]> {
  const rows = await tx
    .select()
    .from(oauthAuthorizations)
    .where(and(eq(oauthAuthorizations.userId, userId), isNull(oauthAuthorizations.revokedAt)))
    .orderBy(desc(oauthAuthorizations.updatedAt));
  const { rows: apps } = await tx.execute<{
    authorization_id: string;
    app_id: string;
    name: string;
    homepage_url: string | null;
  }>(sql`SELECT * FROM oauth_authorized_apps()`);
  const appOf = new Map(apps.map((a) => [a.authorization_id, a]));
  return rows.flatMap((row) => {
    const app = appOf.get(row.id);
    // A deleted app's authorizations are dead: they aren't listed.
    if (!app) return [];
    return [
      {
        id: row.id,
        app: { id: app.app_id, name: app.name, homepageUrl: app.homepage_url },
        scopes: knownScopes(row.scopes),
        workspaceIds: row.workspaceIds,
        baseIds: row.baseIds,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      },
    ];
  });
}

/** Revokes one of the user's authorizations: every token under it stops working at once. */
export async function revokeAuthorization(
  tx: Transaction,
  userId: string,
  authorizationId: string
): Promise<{ appId: string }> {
  const [row] = await tx
    .update(oauthAuthorizations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizations.id, authorizationId),
        eq(oauthAuthorizations.userId, userId),
        isNull(oauthAuthorizations.revokedAt)
      )
    )
    .returning({ appId: oauthAuthorizations.appId });
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such authorization.' });
  return row;
}

// ---- the consent screen ----

interface LookedUpApp extends Record<string, unknown> {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  homepage_url: string | null;
  secret_hash: string;
  redirect_uris: string[];
}

async function appByClientId(db: Db, clientId: string): Promise<LookedUpApp | null> {
  if (clientId === '' || clientId.length > 100) return null;
  const { rows } = await db.execute<LookedUpApp>(sql`SELECT * FROM oauth_app_lookup(${clientId})`);
  return rows[0] ?? null;
}

/** The app's redirect URI with these parameters added (its own query string kept). */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * A request the consent screen can't show. Until the client id and redirect URI check out the
 * browser never goes back to the app (RFC 6749 §4.1.2.1); after that, `redirectTo` carries the
 * OAuth error to the app.
 */
function badRequest(detail: string, redirectTo?: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail,
    ...(redirectTo ? { extensions: { redirectTo } } : {}),
  });
}

interface CheckedRequest {
  app: LookedUpApp;
  redirectUri: string;
  scopes: TokenScope[];
}

function checkRequest(
  app: LookedUpApp | null,
  q: {
    redirectUri: string | undefined;
    responseType: string | undefined;
    scope: string | undefined;
    state: string | undefined;
    codeChallenge: string | undefined;
    codeChallengeMethod: string | undefined;
  }
): CheckedRequest {
  if (!app) throw badRequest('This app is not registered (unknown client_id).');
  // Exact matches only; an app with one redirect URI may leave it out.
  const redirectUri =
    q.redirectUri ?? (app.redirect_uris.length === 1 ? app.redirect_uris[0] : undefined);
  if (!redirectUri || !app.redirect_uris.includes(redirectUri)) {
    throw badRequest("The redirect_uri isn't one this app registered.");
  }
  const fail = (error: string, description: string) =>
    badRequest(
      description,
      redirectWith(redirectUri, { error, error_description: description, state: q.state })
    );
  if (q.responseType !== 'code') {
    throw fail('unsupported_response_type', 'Only response_type=code is supported.');
  }
  const scopes = parseOAuthScope(q.scope ?? '');
  if (!scopes) throw fail('invalid_scope', 'The scope is missing or names an unknown scope.');
  if (q.codeChallengeMethod !== 'S256' || !OAUTH_PKCE_CHALLENGE.test(q.codeChallenge ?? '')) {
    throw fail(
      'invalid_request',
      'PKCE is required: code_challenge with code_challenge_method=S256.'
    );
  }
  return { app, redirectUri, scopes };
}

async function liveAuthorization(tx: Transaction, userId: string, appId: string) {
  const [row] = await tx
    .select()
    .from(oauthAuthorizations)
    .where(
      and(
        eq(oauthAuthorizations.userId, userId),
        eq(oauthAuthorizations.appId, appId),
        isNull(oauthAuthorizations.revokedAt)
      )
    );
  return row ?? null;
}

/** The consent screen's request, checked, with what the person granted the app before. */
export async function authorizeInfo(
  tx: Transaction,
  userId: string,
  q: OAuthAuthorizeQuery
): Promise<OAuthAuthorizeInfo> {
  const app = await appByClientId(tx, q.client_id ?? '');
  const checked = checkRequest(app, {
    redirectUri: q.redirect_uri,
    responseType: q.response_type,
    scope: q.scope,
    state: q.state,
    codeChallenge: q.code_challenge,
    codeChallengeMethod: q.code_challenge_method,
  });
  const current = await liveAuthorization(tx, userId, checked.app.id);
  return {
    app: {
      name: checked.app.name,
      description: checked.app.description,
      homepageUrl: checked.app.homepage_url,
    },
    clientId: q.client_id ?? '',
    redirectUri: checked.redirectUri,
    scopes: checked.scopes,
    current: current ? { workspaceIds: current.workspaceIds, baseIds: current.baseIds } : null,
  };
}

/**
 * The person's answer. Allowing records (or replaces) their authorization of the app with the
 * scopes it asked for and the workspaces or bases they picked, which they must be able to reach
 * now, then issues a one-use code bound to the redirect URI and the PKCE challenge.
 */
export async function decide(
  tx: Transaction,
  userId: string,
  input: z.output<typeof oauthAuthorizeDecisionSchema>,
  now: () => number = Date.now
): Promise<{
  redirectTo: string;
  authorization: { id: string; appId: string; appName: string } | null;
}> {
  const app = await appByClientId(tx, input.clientId);
  const checked = checkRequest(app, {
    redirectUri: input.redirectUri,
    responseType: 'code',
    scope: input.scope,
    state: input.state,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
  });
  if (input.decision === 'deny') {
    return {
      redirectTo: redirectWith(checked.redirectUri, {
        error: 'access_denied',
        error_description: 'The person declined.',
        state: input.state,
      }),
      authorization: null,
    };
  }
  await assertGrantable(tx, userId, input);
  // One consent at a time per person and app, so the live authorization stays unique.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`oauth:${userId}:${checked.app.id}`}, 0))`
  );
  const at = new Date(now());
  const existing = await liveAuthorization(tx, userId, checked.app.id);
  const grant = {
    scopes: checked.scopes,
    workspaceIds: input.workspaceIds,
    baseIds: input.baseIds,
    updatedAt: at,
  };
  const [authorization] = existing
    ? await tx
        .update(oauthAuthorizations)
        .set(grant)
        .where(eq(oauthAuthorizations.id, existing.id))
        .returning()
    : await tx
        .insert(oauthAuthorizations)
        .values({ id: uuidv7(), userId, appId: checked.app.id, createdAt: at, ...grant })
        .returning();
  if (!authorization) throw new Error('decide: no authorization');
  const { code, hash } = generateCode();
  await tx.insert(oauthCodes).values({
    id: uuidv7(),
    codeHash: hash,
    userId,
    authorizationId: authorization.id,
    redirectUri: checked.redirectUri,
    codeChallenge: input.codeChallenge,
    expiresAt: new Date(at.getTime() + OAUTH_CODE_TTL_SECONDS * 1000),
    createdAt: at,
  });
  return {
    redirectTo: redirectWith(checked.redirectUri, { code, state: input.state }),
    authorization: { id: authorization.id, appId: checked.app.id, appName: checked.app.name },
  };
}

// ---- the token endpoint ----

/** An RFC 6749 §5.2 error: `{ error, error_description }` with its status. */
export class OAuthError extends Error {
  constructor(
    readonly error:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unsupported_grant_type'
      | 'invalid_scope',
    readonly description: string
  ) {
    super(description);
  }
  get status(): 400 | 401 {
    return this.error === 'invalid_client' ? 401 : 400;
  }
}

/** The client's credentials, from HTTP Basic or the form body. */
export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** The app whose client id and secret these are, or invalid_client. */
async function authenticateClient(db: Database, creds: ClientCredentials): Promise<LookedUpApp> {
  const app = await appByClientId(db, creds.clientId);
  const given = clientSecretHash(creds.clientSecret);
  const matches = sameHash(app?.secret_hash, given ?? '0'.repeat(64));
  if (!app || !given || !matches) {
    throw new OAuthError('invalid_client', 'Unknown client, or a wrong client secret.');
  }
  return app;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  scope: string;
}

async function issueTokens(
  tx: Transaction,
  authorization: { id: string; userId: string; scopes: readonly string[] },
  now: number
): Promise<TokenResponse> {
  const make = async (kind: OAuthTokenKind, ttlMs: number) => {
    const t = generateOAuthToken(kind);
    await tx.insert(oauthTokens).values({
      id: uuidv7(),
      authorizationId: authorization.id,
      userId: authorization.userId,
      kind,
      publicId: t.publicId,
      secretHash: t.secretHash,
      expiresAt: new Date(now + ttlMs),
      createdAt: new Date(now),
    });
    return t.token;
  };
  const refreshMs = OAUTH_REFRESH_TOKEN_TTL_DAYS * DAY_MS;
  return {
    access_token: await make('access', OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000),
    token_type: 'Bearer',
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: await make('refresh', refreshMs),
    refresh_expires_in: refreshMs / 1000,
    scope: knownScopes(authorization.scopes).join(' '),
  };
}

async function activeUser(tx: Transaction, userId: string): Promise<boolean> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  return Boolean(user && user.suspendedAt === null);
}

async function revokeIn(tx: Transaction, authorizationId: string): Promise<void> {
  await tx
    .update(oauthAuthorizations)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthAuthorizations.id, authorizationId), isNull(oauthAuthorizations.revokedAt)));
}

interface CodeRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  authorization_id: string;
  app_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

const BAD_CODE = () =>
  new OAuthError('invalid_grant', 'The code is invalid, expired, used or not for this client.');

/**
 * `grant_type=authorization_code`: the code is used up first (a second use, an attacker's or a
 * replay, revokes the authorization and every token it gave, RFC 6749 §4.1.2), then checked:
 * this client, not expired, the same redirect URI, and the PKCE verifier.
 */
export async function exchangeCode(
  db: Database,
  creds: ClientCredentials,
  input: { code: string; redirectUri: string | undefined; codeVerifier: string },
  now: () => number = Date.now
): Promise<TokenResponse> {
  const app = await authenticateClient(db, creds);
  const hash = codeHash(input.code);
  if (!hash) throw BAD_CODE();
  const { rows } = await db.execute<CodeRow>(sql`SELECT * FROM oauth_code_lookup(${hash})`);
  const row = rows[0];
  if (!row || row.app_id !== app.id) throw BAD_CODE();
  const outcome = await inScope(db, { userId: row.user_id }, async (tx) => {
    const used = await tx
      .update(oauthCodes)
      .set({ usedAt: new Date(now()) })
      .where(and(eq(oauthCodes.id, row.id), isNull(oauthCodes.usedAt)))
      .returning({ id: oauthCodes.id });
    if (used.length === 0) {
      await revokeIn(tx, row.authorization_id);
      return null;
    }
    if (new Date(row.expires_at).getTime() <= now()) return null;
    if ((input.redirectUri ?? row.redirect_uri) !== row.redirect_uri) return null;
    if (!pkceMatches(input.codeVerifier, row.code_challenge)) return null;
    const [authorization] = await tx
      .select()
      .from(oauthAuthorizations)
      .where(
        and(eq(oauthAuthorizations.id, row.authorization_id), isNull(oauthAuthorizations.revokedAt))
      );
    if (!authorization || !(await activeUser(tx, row.user_id))) return null;
    return issueTokens(tx, authorization, now());
  });
  if (!outcome) throw BAD_CODE();
  return outcome;
}

interface TokenRow extends Record<string, unknown> {
  id: string;
  kind: OAuthTokenKind;
  user_id: string;
  authorization_id: string;
  secret_hash: string;
  expires_at: Date | string;
  used_at: Date | string | null;
  created_at: Date | string;
  app_id: string;
  app_name: string;
  scopes: string[];
  workspace_ids: string[];
  base_ids: string[];
  live: boolean;
}

/** The row of a well-formed token of `kind` whose secret matches, else null. */
async function lookupToken(db: Db, kind: OAuthTokenKind, raw: string): Promise<TokenRow | null> {
  const parsed = parseOAuthToken(kind, raw);
  if (!parsed) return null;
  const { rows } = await db.execute<TokenRow>(
    sql`SELECT * FROM oauth_token_lookup(${parsed.publicId})`
  );
  const row = rows[0];
  if (!sameHash(row?.secret_hash, parsed.secretHash) || !row || row.kind !== kind) return null;
  return row;
}

const BAD_REFRESH = () =>
  new OAuthError('invalid_grant', 'The refresh token is invalid, expired, used or revoked.');

/**
 * `grant_type=refresh_token`: rotation. The refresh token is used up and a new access and
 * refresh token issued; a refresh token used a second time revokes the authorization (it has
 * leaked: either the app or an attacker holds the newer one).
 */
export async function refreshTokens(
  db: Database,
  creds: ClientCredentials,
  refreshToken: string,
  now: () => number = Date.now
): Promise<TokenResponse> {
  const app = await authenticateClient(db, creds);
  const row = await lookupToken(db, 'refresh', refreshToken);
  if (!row || row.app_id !== app.id || !row.live) throw BAD_REFRESH();
  const outcome = await inScope(db, { userId: row.user_id }, async (tx) => {
    const used = await tx
      .update(oauthTokens)
      .set({ usedAt: new Date(now()) })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.usedAt)))
      .returning({ id: oauthTokens.id });
    if (used.length === 0) {
      await revokeIn(tx, row.authorization_id);
      return null;
    }
    if (new Date(row.expires_at).getTime() <= now()) return null;
    if (!(await activeUser(tx, row.user_id))) return null;
    return issueTokens(
      tx,
      { id: row.authorization_id, userId: row.user_id, scopes: row.scopes },
      now()
    );
  });
  if (!outcome) throw BAD_REFRESH();
  return outcome;
}

/**
 * RFC 7009 revocation by the app: a refresh token ends its whole authorization, an access token
 * itself. Unknown tokens and other apps' tokens are ignored (the answer is the same).
 */
export async function revokeByClient(
  db: Database,
  creds: ClientCredentials,
  token: string
): Promise<{ userId: string; authorizationId: string; appName: string } | null> {
  const app = await authenticateClient(db, creds);
  const kind: OAuthTokenKind = token.startsWith('or_ort_') ? 'refresh' : 'access';
  const row = await lookupToken(db, kind, token);
  if (!row || row.app_id !== app.id) return null;
  await inScope(db, { userId: row.user_id }, async (tx) => {
    if (kind === 'refresh') await revokeIn(tx, row.authorization_id);
    else {
      await tx
        .update(oauthTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.usedAt)));
    }
  });
  return kind === 'refresh'
    ? { userId: row.user_id, authorizationId: row.authorization_id, appName: row.app_name }
    : null;
}

/**
 * The principal of an OAuth access token (`or_oat_…`), or null when it is malformed, unknown,
 * expired, revoked, or its authorization or app is gone (the caller answers 401 alike). It acts
 * as its person, narrowed to the authorization's scopes and grants, like a personal access
 * token; its rate limit bucket is the authorization's.
 */
export async function resolveOAuthToken(
  db: Database,
  raw: string,
  now: () => number = Date.now
): Promise<Principal | null> {
  const row = await lookupToken(db, 'access', raw);
  if (!row?.live || row.used_at !== null) return null;
  const expiresAt = new Date(row.expires_at);
  if (expiresAt.getTime() <= now()) return null;
  const [user] = await db.select().from(users).where(eq(users.id, row.user_id));
  if (!user || user.suspendedAt !== null) return null;
  await db.execute(sql`SELECT oauth_touch(${row.authorization_id}::uuid)`);
  return {
    user,
    session: { idHash: '', expiresAt, createdAt: new Date(row.created_at) },
    token: {
      id: row.authorization_id,
      scopes: knownScopes(row.scopes),
      workspaceIds: row.workspace_ids,
      baseIds: row.base_ids,
      oauthApp: { id: row.app_id, name: row.app_name },
    },
  };
}

/** The worker's hourly prune of expired codes and tokens. */
export async function pruneOAuth(db: Database): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`SELECT oauth_prune() AS n`);
  return Number(rows[0]?.n ?? 0);
}
