import { MAX_CONNECTOR_ITEMS, type SyncConnectorInfo } from '@openrows/shared';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Cipher } from '../../auth/crypto.js';
import { syncConnectorAccounts, type Transaction } from '../../db/index.js';
import type { SafeFetch } from '../../lib/safe-fetch/index.js';
import { type ExternalRows, SourceError } from './types.js';

/**
 * Sync connectors: sources an edition plugs into the sync engine, each read
 * through the person's own account at the provider (OAuth 2 with PKCE). The core keeps the
 * accounts (tokens encrypted, `sync_connector_accounts`), runs the connect and disconnect flow,
 * refreshes tokens and maps the rows like any external source; the connector only speaks its
 * provider's API. The OSS edition has none; the hosted one adds Google Sheets.
 */

/** A connected account's tokens, as the connector gives them; kept encrypted. */
export interface ConnectorTokens {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token expires (epoch ms), or null when it doesn't say. */
  expiresAt: number | null;
}

/** One item of a picker level (a spreadsheet, a sheet). */
export interface ConnectorItem {
  id: string;
  name: string;
  detail?: string | null;
  /** The last level: picking it completes the source. */
  leaf: boolean;
}

/** What a connector's calls get: the SSRF-safe client every provider request goes through. */
export interface ConnectorContext {
  http: SafeFetch;
}

/** A connector source as stored: the picked path and the header row. */
export interface ConnectorSource {
  path: string[];
  headerRow: number;
}

/** A read of a connector source: its rows (the header row's names as columns) and names. */
export interface ConnectorRead extends Omit<ExternalRows, 'state'> {
  /** e.g. "Budget 2026 / Sheet1". */
  label: string;
}

/**
 * A sync source an edition adds. Methods throw SourceError (a message safe to show) for
 * problems with the source, ConnectorAuthError when the account's grant is gone (revoked,
 * expired), and TooManyRows past `maxRows`.
 */
export interface SyncConnector {
  /** Lower-case letters, digits, dashes (SYNC_CONNECTOR_ID). */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The picker's levels, outermost first: a source's path has one id per level. */
  readonly levels: readonly string[];
  /** The provider's consent page for this flow (PKCE S256). */
  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(
    ctx: ConnectorContext,
    input: { code: string; codeVerifier: string; redirectUri: string }
  ): Promise<ConnectorTokens>;
  /** New tokens from the refresh token (ConnectorAuthError when the grant is gone). */
  refresh(ctx: ConnectorContext, tokens: ConnectorTokens): Promise<ConnectorTokens>;
  /** Revokes the grant at the provider (best effort: the account is deleted anyway). */
  revoke(ctx: ConnectorContext, tokens: ConnectorTokens): Promise<void>;
  /** What the provider calls the account (an email address). */
  accountLabel(ctx: ConnectorContext, accessToken: string): Promise<string>;
  /** A level's items: `path` holds the ids picked so far ([] for the first level). */
  browse(
    ctx: ConnectorContext,
    accessToken: string,
    input: { path: string[]; search?: string | undefined }
  ): Promise<ConnectorItem[]>;
  /** The source's label and default table name, without reading its rows. */
  describe(
    ctx: ConnectorContext,
    accessToken: string,
    source: ConnectorSource
  ): Promise<{ label: string; tableName: string }>;
  read(
    ctx: ConnectorContext,
    accessToken: string,
    source: ConnectorSource,
    opts: { maxRows: number }
  ): Promise<ConnectorRead>;
}

/** The account's grant is gone at the provider: its owner must connect again. */
export class ConnectorAuthError extends Error {
  constructor(message = 'the connected account was revoked', options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConnectorAuthError';
  }
}

/** The edition's connectors by id. */
export type ConnectorRegistry = ReadonlyMap<string, SyncConnector>;

export function connectorRegistry(list: readonly SyncConnector[] = []): ConnectorRegistry {
  const map = new Map<string, SyncConnector>();
  for (const c of list) {
    if (map.has(c.id)) throw new Error(`two sync connectors are called ${c.id}`);
    map.set(c.id, c);
  }
  return map;
}

/** What the core needs around the connectors: the registry, the token cipher, the client. */
export interface ConnectorDeps {
  connectors: ConnectorRegistry;
  cipher: Cipher;
  http: SafeFetch;
}

/** An access token refreshed this long before it expires. */
const REFRESH_MARGIN_MS = 60_000;

type AccountRow = typeof syncConnectorAccounts.$inferSelect;

/** The connectors with the caller's accounts (in the caller's user scope). */
export async function listConnectors(
  tx: Transaction,
  deps: Pick<ConnectorDeps, 'connectors'>,
  userId: string
): Promise<SyncConnectorInfo[]> {
  if (!deps.connectors.size) return [];
  const accounts = await tx
    .select()
    .from(syncConnectorAccounts)
    .where(eq(syncConnectorAccounts.userId, userId));
  return [...deps.connectors.values()].map((c) => {
    const account = accounts.find((a) => a.connector === c.id);
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      levels: [...c.levels],
      account: account
        ? { label: account.label, connectedAt: account.createdAt.toISOString() }
        : null,
    };
  });
}

/** Stores (or replaces) the person's account at the connector. */
export async function saveAccount(
  tx: Transaction,
  deps: Pick<ConnectorDeps, 'cipher'>,
  input: { userId: string; connector: string; label: string; tokens: ConnectorTokens }
): Promise<void> {
  const tokensEncrypted = deps.cipher.encrypt(JSON.stringify(input.tokens));
  const now = new Date();
  await tx
    .insert(syncConnectorAccounts)
    .values({
      id: uuidv7(),
      userId: input.userId,
      connector: input.connector,
      label: input.label.slice(0, 255),
      tokensEncrypted,
    })
    .onConflictDoUpdate({
      target: [syncConnectorAccounts.userId, syncConnectorAccounts.connector],
      set: { label: input.label.slice(0, 255), tokensEncrypted, createdAt: now, updatedAt: now },
    });
}

async function loadAccount(
  tx: Transaction,
  userId: string,
  connector: string
): Promise<AccountRow | undefined> {
  const [row] = await tx
    .select()
    .from(syncConnectorAccounts)
    .where(
      and(eq(syncConnectorAccounts.userId, userId), eq(syncConnectorAccounts.connector, connector))
    );
  return row;
}

function openTokens(deps: Pick<ConnectorDeps, 'cipher'>, row: AccountRow): ConnectorTokens | null {
  const text = deps.cipher.decrypt(row.tokensEncrypted);
  if (text === undefined) return null;
  try {
    const t = JSON.parse(text) as Partial<ConnectorTokens>;
    if (typeof t.accessToken !== 'string') return null;
    return {
      accessToken: t.accessToken,
      refreshToken: typeof t.refreshToken === 'string' ? t.refreshToken : null,
      expiresAt: typeof t.expiresAt === 'number' ? t.expiresAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * Deletes the person's account at the connector after revoking its grant at the provider (a
 * failed revoke doesn't keep the account). False when there was none.
 */
export async function disconnectAccount(
  tx: Transaction,
  deps: ConnectorDeps,
  userId: string,
  connectorId: string
): Promise<boolean> {
  const row = await loadAccount(tx, userId, connectorId);
  if (!row) return false;
  const connector = deps.connectors.get(connectorId);
  const tokens = openTokens(deps, row);
  if (connector && tokens) {
    try {
      await connector.revoke({ http: deps.http }, tokens);
    } catch {
      // Deleted here anyway; the provider's grant lapses unused.
    }
  }
  await tx.delete(syncConnectorAccounts).where(eq(syncConnectorAccounts.id, row.id));
  return true;
}

/** No account, or one whose grant is gone: the person must connect (again). */
export class NotConnected extends SourceError {
  constructor(connector: SyncConnector) {
    super(`Connect your ${connector.name} account first.`);
    this.name = 'NotConnected';
  }
}

/**
 * A live access token of `userId`'s account at the connector (in a scope where app.user_id is
 * theirs), refreshed and stored again when it is about to expire. Throws NotConnected when
 * there's no usable account (none, unreadable, or its grant revoked at the provider).
 */
export async function accessToken(
  tx: Transaction,
  deps: ConnectorDeps,
  connector: SyncConnector,
  userId: string,
  now: () => number = Date.now
): Promise<string> {
  const row = await loadAccount(tx, userId, connector.id);
  const tokens = row ? openTokens(deps, row) : null;
  if (!row || !tokens) throw new NotConnected(connector);
  if (tokens.expiresAt === null || tokens.expiresAt - REFRESH_MARGIN_MS > now()) {
    return tokens.accessToken;
  }
  let fresh: ConnectorTokens;
  try {
    fresh = await connector.refresh({ http: deps.http }, tokens);
  } catch (err) {
    if (err instanceof ConnectorAuthError) throw new NotConnected(connector);
    throw err;
  }
  const kept = { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken };
  await tx
    .update(syncConnectorAccounts)
    .set({ tokensEncrypted: deps.cipher.encrypt(JSON.stringify(kept)), updatedAt: new Date() })
    .where(eq(syncConnectorAccounts.id, row.id));
  return kept.accessToken;
}

/** The connector, or a 422-worthy SourceError when this server has no such connector. */
export function connectorOf(deps: Pick<ConnectorDeps, 'connectors'>, id: string): SyncConnector {
  const connector = deps.connectors.get(id);
  if (!connector) throw new SourceError('This source is not available on this server.');
  return connector;
}

/** A level's items, capped, with the connector's problems as SourceError. */
export async function browseConnector(
  tx: Transaction,
  deps: ConnectorDeps,
  userId: string,
  input: { connector: string; path: string[]; search?: string | undefined }
): Promise<ConnectorItem[]> {
  const connector = connectorOf(deps, input.connector);
  if (input.path.length >= connector.levels.length) {
    throw new SourceError('There is nothing more to pick.');
  }
  const token = await accessToken(tx, deps, connector, userId);
  try {
    const items = await connector.browse({ http: deps.http }, token, {
      path: input.path,
      search: input.search,
    });
    return items.slice(0, MAX_CONNECTOR_ITEMS);
  } catch (err) {
    if (err instanceof ConnectorAuthError) throw new NotConnected(connector);
    throw err;
  }
}
