import { isIP } from 'node:net';
import {
  MAX_SYNC_CELL_CHARS,
  MAX_SYNC_POSTGRES_BYTES,
  POSTGRES_TABLE_NAME,
  SYNC_POSTGRES_STATEMENT_TIMEOUT_MS,
} from '@openrows/shared';
import pg from 'pg';
import { SafeFetchError } from '../../lib/safe-fetch/index.js';
import { columnNames, type ExternalRows, SourceError, TooManyRows } from './types.js';

/**
 * A Postgres table or SELECT query as a sync source. The connection string is parsed here
 * (postgres:// URLs only: user, password, host, port, database and `sslmode`; nothing libpq-only
 * like `host=/socket` or `options=`), and its host goes through the outbound address rules
 * (private, loopback, link-local and metadata addresses refused unless OUTBOUND_HTTP_ALLOW lets
 * them), then the client connects to that pinned address with the hostname kept for TLS. Reads
 * run in a READ ONLY transaction with a statement timeout, through a cursor in pages, capped in
 * rows and bytes; the query is sent with the extended protocol, so it is one statement.
 * Every value comes back as Postgres' text (no type parsing), booleans as true/false.
 */

export type SslMode = 'verify-full' | 'require' | 'disable';

export interface PostgresConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslmode: SslMode;
}

export type HostCheck = (
  hostname: string
) => Promise<{ hostname: string; address: { address: string; family: 4 | 6 } }>;

export interface PostgresSourceDeps {
  /** The outbound address rules (safe-fetch's createHostCheck). */
  hostCheck: HostCheck;
  /** TLS only (the hosted service): `sslmode=disable` is refused. */
  requireTls: boolean;
  /** Extra CA certificates (tests). */
  ca?: string;
}

export interface PostgresSourceConfig {
  table?: string | undefined;
  query?: string | undefined;
}

/** The whole read's deadline, connection included. */
export const POSTGRES_DEADLINE_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
const PAGE = 500;

const SSL_MODES: Record<string, SslMode> = {
  'verify-full': 'verify-full',
  require: 'require',
  disable: 'disable',
};

/** Parses a postgres:// connection string, or throws SourceError (never echoing it). */
export function parseConnectionString(input: string, requireTls: boolean): PostgresConnection {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SourceError("The connection string isn't a valid postgres:// URL.");
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new SourceError('The connection string must start with postgres://.');
  }
  if (!url.hostname) throw new SourceError('The connection string has no host.');
  const user = safeDecode(url.username);
  if (!user) throw new SourceError('The connection string has no user name.');
  const database = safeDecode(url.pathname.replace(/^\//, ''));
  if (!database || database.includes('/')) {
    throw new SourceError('The connection string has no database name.');
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SourceError("The connection string's port isn't valid.");
  }
  let sslmode: SslMode = 'verify-full';
  for (const [key, value] of url.searchParams) {
    if (key !== 'sslmode') {
      throw new SourceError(
        `The connection string's "${key.slice(0, 40)}" setting isn't supported.`
      );
    }
    const mode = SSL_MODES[value];
    if (!mode) throw new SourceError('sslmode must be verify-full, require or disable.');
    sslmode = mode;
  }
  if (requireTls && sslmode === 'disable') {
    throw new SourceError(
      'OpenRows only connects to databases over TLS here: remove sslmode=disable.'
    );
  }
  return {
    host: url.hostname,
    port,
    user,
    password: safeDecode(url.password),
    database,
    sslmode,
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new SourceError("The connection string isn't a valid postgres:// URL.");
  }
}

/** "db.example.com/crm · public.people" (no user or password). */
export function postgresLabel(conn: PostgresConnection, config: PostgresSourceConfig): string {
  const what = config.table ?? 'SQL query';
  const label = `${conn.host}/${conn.database} · ${what}`;
  return label.length > 120 ? `${label.slice(0, 119)}…` : label;
}

/** The new table's default name: the table's (without its schema) or "Query". */
export function postgresTableName(config: PostgresSourceConfig): string {
  return config.table?.split('.').pop() ?? 'Query';
}

/** `"schema"."table"` for a checked name (POSTGRES_TABLE_NAME). */
export function quotedTable(name: string): string {
  if (!POSTGRES_TABLE_NAME.test(name)) throw new SourceError('Enter a table as schema.table.');
  return name
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
}

/**
 * The query as the inner part of `SELECT * FROM (…)`: comments and whitespace before it allowed,
 * it must start with SELECT or WITH; trailing semicolons dropped.
 */
export function checkedQuery(query: string): string {
  const body = query.trim().replace(/;+\s*$/, '');
  const head = body.replace(/^(\s+|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)*/, '');
  if (!/^(select|with)\b/i.test(head)) {
    throw new SourceError('The query must be one SELECT statement (or WITH … SELECT).');
  }
  return body;
}

function sourceSql(config: PostgresSourceConfig): string {
  if (config.table) return `SELECT * FROM ${quotedTable(config.table)}`;
  if (config.query) return `SELECT * FROM (\n${checkedQuery(config.query)}\n) AS openrows_source`;
  throw new SourceError('Give a table or a query.');
}

const BOOL_OID = 16;

/** A Postgres type OID's suggested column type: the preview's guess (the user can change it). */
export function suggestedType(oid: number): { type: string; options: Record<string, unknown> } {
  switch (oid) {
    case BOOL_OID:
      return { type: 'checkbox', options: {} };
    case 20:
    case 21:
    case 23:
      return { type: 'number', options: { precision: 0 } };
    case 700:
    case 701:
    case 1700:
      return { type: 'number', options: { precision: 2 } };
    case 1082:
      return { type: 'date', options: { dateFormat: 'iso' } };
    case 1114:
    case 1184:
      return { type: 'dateTime', options: {} };
    case 114:
    case 3802:
      return { type: 'longText', options: {} };
    default:
      return { type: 'singleLineText', options: {} };
  }
}

/** A user-safe message for a failed connection or query (no addresses or credentials). */
export function postgresProblem(err: unknown): SourceError {
  if (err instanceof SourceError) return err;
  if (err instanceof SafeFetchError) {
    return new SourceError(`Couldn't connect to the database: ${err.message}.`, { cause: err });
  }
  const e = err as { code?: unknown; severity?: unknown; message?: unknown };
  const message = typeof e?.message === 'string' ? e.message : '';
  // The database's own error (SQLSTATE and severity): its message is about the user's query.
  if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && e.severity) {
    if (e.code === '57014') {
      return new SourceError('The query ran past the time limit.', { cause: err });
    }
    return new SourceError(`The database answered: ${message.slice(0, 300)}`, { cause: err });
  }
  if (/does not support SSL/i.test(message)) {
    return new SourceError("The database doesn't accept TLS connections.", { cause: err });
  }
  const code = typeof e?.code === 'string' ? e.code : '';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|HOSTNAME/i.test(code)) {
    return new SourceError(
      "The database's TLS certificate couldn't be verified (sslmode=require accepts it unverified).",
      { cause: err }
    );
  }
  if (/timeout/i.test(message)) {
    return new SourceError("The database didn't answer in time.", { cause: err });
  }
  return new SourceError("Couldn't connect to the database.", { cause: err });
}

/** Every value as text: no type parsers, so dates and numbers stay what Postgres printed. */
const textTypes = { getTypeParser: () => (value: string) => value };

/**
 * Reads the source's rows (up to `maxRows`, else TooManyRows; `limit` for a preview), as text.
 * Throws SourceError with a safe message for every failure.
 */
export async function readPostgres(
  deps: PostgresSourceDeps,
  connectionString: string,
  config: PostgresSourceConfig,
  opts: { maxRows: number; limit?: number }
): Promise<ExternalRows & { types: number[] }> {
  const conn = parseConnectionString(connectionString, deps.requireTls);
  const sql = sourceSql(config);
  let client: pg.Client | undefined;
  const deadline = setTimeout(() => {
    client?.end().catch(() => {});
  }, POSTGRES_DEADLINE_MS);
  try {
    const { hostname, address } = await deps.hostCheck(conn.host);
    client = new pg.Client({
      host: address.address,
      port: conn.port,
      user: conn.user,
      // A function: an empty password would otherwise fall back to this server's PGPASSWORD
      // (or ~/.pgpass), which must never reach a user-chosen host.
      password: () => conn.password,
      database: conn.database,
      ssl:
        conn.sslmode === 'disable'
          ? false
          : {
              rejectUnauthorized: conn.sslmode === 'verify-full',
              ...(isIP(hostname) ? {} : { servername: hostname }),
              ...(deps.ca ? { ca: deps.ca } : {}),
            },
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: SYNC_POSTGRES_STATEMENT_TIMEOUT_MS,
      query_timeout: SYNC_POSTGRES_STATEMENT_TIMEOUT_MS + 5_000,
      application_name: 'OpenRows sync',
      types: textTypes,
    });
    client.on('error', () => {});
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL TimeZone = 'UTC'");
    await client.query(`SET LOCAL statement_timeout = ${SYNC_POSTGRES_STATEMENT_TIMEOUT_MS}`);
    const cap = opts.limit ?? opts.maxRows + 1;
    // Extended protocol: one statement only, whatever the query holds.
    const declare = {
      text: `DECLARE openrows_sync NO SCROLL CURSOR FOR ${sql} LIMIT ${cap}`,
      queryMode: 'extended',
    } as pg.QueryConfig;
    await client.query(declare);
    let names: string[] | undefined;
    let types: number[] = [];
    const rows: (string | null)[][] = [];
    let bytes = 0;
    for (;;) {
      const page = await client.query<unknown[]>({
        text: `FETCH ${PAGE} FROM openrows_sync`,
        rowMode: 'array',
      });
      if (!names) {
        names = columnNames(page.fields.map((f) => f.name));
        types = page.fields.map((f) => f.dataTypeID);
      }
      for (const raw of page.rows) {
        const row = raw.map((value, i) => {
          if (value === null || value === undefined) return null;
          let text = String(value);
          if (types[i] === BOOL_OID) text = text === 't' ? 'true' : 'false';
          bytes += text.length;
          return text.length > MAX_SYNC_CELL_CHARS ? text.slice(0, MAX_SYNC_CELL_CHARS) : text;
        });
        rows.push(row);
      }
      if (rows.length > opts.maxRows) throw new TooManyRows();
      if (bytes > MAX_SYNC_POSTGRES_BYTES) {
        throw new SourceError(
          `The rows weigh more than ${MAX_SYNC_POSTGRES_BYTES / 1024 / 1024} MB as text.`
        );
      }
      if (page.rows.length < PAGE) break;
    }
    await client.query('ROLLBACK');
    return { columns: names ?? [], rows, types, state: {} };
  } catch (err) {
    if (err instanceof TooManyRows) throw err;
    throw postgresProblem(err);
  } finally {
    clearTimeout(deadline);
    await client?.end().catch(() => {});
  }
}
