import {
  type ExternalSyncSource,
  inferField,
  MAX_SYNC_FIELDS,
  MAX_SYNC_RECORDS,
  SYNC_COLUMN_TYPES,
  SYNC_PREVIEW_ROWS,
  type SyncColumnType,
  type SyncPreview,
} from '@openrows/shared';
import { type Cipher, createCipher } from '../../auth/crypto.js';
import {
  createHostCheck,
  createSafeFetch,
  createUrlCheck,
  type OutboundConfig,
  outboundPolicy,
  type SafeFetch,
  SafeFetchError,
} from '../../lib/safe-fetch/index.js';
import {
  ConnectorAuthError,
  type ConnectorDeps,
  type ConnectorSource,
  connectorOf,
  connectorRegistry,
  NotConnected,
  type SyncConnector,
} from './connectors.js';
import { type CsvState, csvLabel, csvTableName, readCsv } from './csv.js';
import {
  checkedQuery,
  type PostgresSourceConfig,
  type PostgresSourceDeps,
  parseConnectionString,
  postgresLabel,
  postgresProblem,
  postgresTableName,
  readPostgres,
  suggestedType,
} from './postgres.js';
import { type ExternalRead, SourceError, TooManyRows } from './types.js';

export {
  accessToken,
  browseConnector,
  type ConnectorDeps,
  type ConnectorItem,
  disconnectAccount,
  listConnectors,
  NotConnected,
  type SyncConnector,
  saveAccount,
} from './connectors.js';
export { SourceError, TooManyRows } from './types.js';

/** A live access token of the acting person's account at a connector. */
export type ConnectorToken = (connector: SyncConnector) => Promise<string>;

/**
 * External sync sources: what the API (create, preview) and the worker (runs) need to
 * reach them. The URL or connection string is the source's secret, kept encrypted
 * (`sync-source`); the rest (a Postgres table or query) is its config.
 */
export interface SyncSources {
  cipher: Cipher;
  /** The SSRF-safe client, for CSV URLs. */
  http: SafeFetch;
  /** The same rules without connecting, for a CSV URL saved now and read later. */
  urlCheck: (url: string) => Promise<void>;
  postgres: PostgresSourceDeps;
  /** The edition's sync connectors and their accounts' token cipher. */
  connectors: ConnectorDeps;
}

/**
 * The sources of a server or worker: the outbound rules (OUTBOUND_HTTP_*) for CSV URLs and
 * database hosts alike, so private addresses are refused unless OUTBOUND_HTTP_ALLOW lets them;
 * TLS required for databases on the hosted service (EDITION=cloud).
 */
export function createSyncSources(opts: {
  encryptionKey: string;
  outbound: OutboundConfig;
  requireTls: boolean;
  /** The edition's sync connectors; none in the OSS edition. */
  connectors?: readonly SyncConnector[] | undefined;
}): SyncSources {
  const policy = outboundPolicy(opts.outbound);
  const http = createSafeFetch(policy);
  return {
    cipher: createCipher(opts.encryptionKey, 'sync-source'),
    http,
    urlCheck: createUrlCheck(policy),
    postgres: { hostCheck: createHostCheck(policy), requireTls: opts.requireTls },
    connectors: {
      connectors: connectorRegistry(opts.connectors),
      cipher: createCipher(opts.encryptionKey, 'sync-connector-tokens'),
      http,
    },
  };
}

/** A connector source's stored config: no secret, the creator's account reads it. */
export interface ConnectorConfig extends ConnectorSource {
  connector: string;
}

export type ExternalKind = ExternalSyncSource['kind'];

/** An external source split into what is kept encrypted and what isn't. */
export interface SplitSource {
  kind: ExternalKind;
  secret: string;
  config: PostgresSourceConfig | ConnectorConfig | Record<string, never>;
  label: string;
  /** The new table's default name. */
  tableName: string;
}

/**
 * Checks an external source without reading it: the CSV URL's or the database host's address
 * (by the outbound rules), the connection string, TLS on the hosted service, the table name or
 * the query's shape. Throws SourceError.
 */
export async function checkSource(
  sources: SyncSources,
  source: ExternalSyncSource,
  token?: ConnectorToken
): Promise<SplitSource> {
  if (source.kind === 'connector') {
    const connector = connectorOf(sources.connectors, source.connector);
    if (source.path.length !== connector.levels.length) {
      throw new SourceError(`Pick a ${connector.levels.at(-1)?.toLowerCase() ?? 'source'}.`);
    }
    const config: ConnectorConfig = {
      connector: connector.id,
      path: source.path,
      headerRow: source.headerRow,
    };
    const named = await connectorCall(connector, async () =>
      connector.describe(
        { http: sources.connectors.http },
        await connectorToken(connector, token),
        config
      )
    );
    return { kind: 'connector', secret: '', config, ...named };
  }
  if (source.kind === 'csv') {
    try {
      await sources.urlCheck(source.url);
    } catch (err) {
      if (err instanceof SafeFetchError) {
        throw new SourceError(`This URL can't be synced: ${err.message}.`, { cause: err });
      }
      throw err;
    }
    return {
      kind: 'csv',
      secret: source.url,
      config: {},
      label: csvLabel(source.url),
      tableName: csvTableName(source.url),
    };
  }
  const conn = parseConnectionString(source.connectionString, sources.postgres.requireTls);
  const config: PostgresSourceConfig = source.table
    ? { table: source.table }
    : { query: checkedQuery(source.query ?? '') };
  try {
    await sources.postgres.hostCheck(conn.host);
  } catch (err) {
    throw postgresProblem(err);
  }
  return {
    kind: 'postgres',
    secret: source.connectionString,
    config,
    label: postgresLabel(conn, config),
    tableName: postgresTableName(config),
  };
}

async function connectorToken(connector: SyncConnector, token?: ConnectorToken) {
  if (!token) throw new NotConnected(connector);
  return token(connector);
}

/** A connector's call, a revoked grant as NotConnected. */
async function connectorCall<T>(connector: SyncConnector, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConnectorAuthError) throw new NotConnected(connector);
    throw err;
  }
}

/** A stored connector source's config, or null when it isn't one. */
export function connectorConfig(config: unknown): ConnectorConfig | null {
  const c = (config ?? {}) as Record<string, unknown>;
  if (typeof c['connector'] !== 'string' || !Array.isArray(c['path'])) return null;
  return {
    connector: c['connector'],
    path: c['path'].filter((p): p is string => typeof p === 'string'),
    headerRow: typeof c['headerRow'] === 'number' ? c['headerRow'] : 1,
  };
}

/** Reads a connector source's rows for a run, with the creator's account. */
export async function readConnector(
  sources: SyncSources,
  config: unknown,
  token: ConnectorToken
): Promise<ExternalRead & { label?: string }> {
  const c = connectorConfig(config);
  if (!c) throw new SourceError('This source is not available on this server.');
  const connector = connectorOf(sources.connectors, c.connector);
  const read = await connectorCall(connector, async () =>
    connector.read({ http: sources.connectors.http }, await token(connector), c, {
      maxRows: MAX_SYNC_RECORDS,
    })
  );
  return {
    notModified: false,
    columns: read.columns,
    rows: read.rows,
    state: {},
    label: read.label,
  };
}

/** Reads an external source's rows for a run (a CSV's conditional GET with `state`). */
export async function readSource(
  sources: SyncSources,
  kind: string,
  secret: string,
  config: unknown,
  state: unknown
): Promise<ExternalRead> {
  if (kind === 'csv') {
    return readCsv(sources.http, secret, {
      state: csvState(state),
      maxRows: MAX_SYNC_RECORDS,
    });
  }
  if (kind === 'postgres') {
    const read = await readPostgres(sources.postgres, secret, postgresConfig(config), {
      maxRows: MAX_SYNC_RECORDS,
    });
    return { notModified: false, ...read };
  }
  throw new SourceError('This kind of source is not supported.');
}

/** Decrypts a stored secret (a different ENCRYPTION_KEY can't read it back). */
export function openSecret(sources: SyncSources, data: Buffer | null): string {
  const secret = data ? sources.cipher.decrypt(data) : undefined;
  if (secret === undefined) {
    throw new SourceError(
      "The source's URL or connection string can't be read: add the sync again."
    );
  }
  return secret;
}

function csvState(state: unknown): CsvState {
  const s = (state ?? {}) as Record<string, unknown>;
  return {
    ...(typeof s['etag'] === 'string' ? { etag: s['etag'] } : {}),
    ...(typeof s['lastModified'] === 'string' ? { lastModified: s['lastModified'] } : {}),
  };
}

function postgresConfig(config: unknown): PostgresSourceConfig {
  const c = (config ?? {}) as Record<string, unknown>;
  return {
    table: typeof c['table'] === 'string' ? c['table'] : undefined,
    query: typeof c['query'] === 'string' ? c['query'] : undefined,
  };
}

/** Rows a Postgres preview reads for its type guesses (it shows SYNC_PREVIEW_ROWS). */
const PREVIEW_SAMPLE = 200;
const PREVIEW_CELL = 200;

/**
 * "Preview": reads the source (a CSV whole, a Postgres source's first 200 rows) and suggests
 * each column's type (a CSV's from its cells, like the CSV import; a database column's from its
 * type). At most MAX_SYNC_FIELDS columns.
 */
export async function previewSource(
  sources: SyncSources,
  source: ExternalSyncSource,
  token?: ConnectorToken
): Promise<SyncPreview> {
  const split = await checkSource(sources, source, token);
  let read: { columns: string[]; rows: (string | null)[][]; types?: number[] };
  try {
    if (split.kind === 'connector') {
      const connector = connectorOf(
        sources.connectors,
        (split.config as ConnectorConfig).connector
      );
      read = await connectorCall(connector, async () =>
        connector.read(
          { http: sources.connectors.http },
          await connectorToken(connector, token),
          split.config as ConnectorConfig,
          { maxRows: MAX_SYNC_RECORDS }
        )
      );
    } else if (split.kind === 'csv') {
      const csv = await readCsv(sources.http, split.secret, { maxRows: MAX_SYNC_RECORDS });
      if (csv.notModified) throw new SourceError('The file could not be read.');
      read = csv;
    } else {
      read = await readPostgres(
        sources.postgres,
        split.secret,
        split.config as PostgresSourceConfig,
        {
          maxRows: PREVIEW_SAMPLE,
          limit: PREVIEW_SAMPLE,
        }
      );
    }
  } catch (err) {
    if (err instanceof TooManyRows) {
      throw new SourceError(
        `The source has more than ${MAX_SYNC_RECORDS.toLocaleString('en')} rows, the most a sync copies.`
      );
    }
    throw err;
  }
  const columns = read.columns.slice(0, MAX_SYNC_FIELDS).map((name, i) => {
    const cells = read.rows.map((r) => r[i] ?? '');
    const guess =
      read.types && suggestedType(read.types[i] ?? 0).type !== 'singleLineText'
        ? suggestedType(read.types[i] ?? 0)
        : inferField(cells);
    const type = (SYNC_COLUMN_TYPES as readonly string[]).includes(guess.type)
      ? (guess.type as SyncColumnType)
      : 'singleLineText';
    return { name, type, options: type === guess.type ? guess.options : {} };
  });
  return {
    label: split.label,
    columns,
    rows: read.rows
      .slice(0, SYNC_PREVIEW_ROWS)
      .map((r) => columns.map((_, i) => (r[i] ?? '').slice(0, PREVIEW_CELL))),
  };
}
