import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  Base,
  RecordData as RecordT,
  SyncPreview,
  TableMeta,
  TableSync,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { tableSyncs } from '../../src/db/index.js';
import {
  createHostCheck,
  createSafeFetch,
  createUrlCheck,
  type OutboundConfig,
  outboundPolicy,
  type ResolvedAddress,
} from '../../src/lib/safe-fetch/index.js';
import { runSyncJob } from '../../src/syncs/run.js';
import { createSyncSources, type SyncSources } from '../../src/syncs/sources/index.js';
import { testApp } from '../helpers/app.js';
import { createDatabase, useTestDb } from '../helpers/db.js';
import { createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Synced tables from a CSV URL and from Postgres, on the engine: a fixture HTTP
 * server (with ETags, so re-runs are conditional GETs) and a real Postgres source database read
 * by a read-only role. Private, loopback and metadata addresses are refused (only this file's
 * servers are allowlisted, as a self-hoster would with OUTBOUND_HTTP_ALLOW), redirects to them
 * too, and the hosted rule that databases speak TLS.
 */
describe('synced tables from CSV URLs and Postgres', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let strictApp: ReturnType<typeof testApp>['app'];
  let owner: string;
  let workspaceId: string;
  let base: Base;
  let sources: SyncSources;
  let encryptionKey: string;

  // The fixture HTTP server: /people.csv (ETag), /html, /redirect (to the metadata address).
  let csv = 'id,Name,Active\n1,Ada,true\n2,Bob,false\n3,Cy,true\n';
  let etag = '"v1"';
  const requests: { path: string; ifNoneMatch: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ path: req.url ?? '', ifNoneMatch: req.headers['if-none-match'] });
    if (req.url === '/people.csv') {
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/csv', etag });
      res.end(csv);
      return;
    }
    if (req.url === '/big.csv') {
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(`n\n${Array.from({ length: 10_001 }, (_, i) => i).join('\n')}\n`);
      return;
    }
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Sign in</title>');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  let httpBase: string;

  // The source database and its read-only role.
  const reader = `sync_reader_${randomUUID().slice(0, 8)}`;
  const readerPassword = 'reader-test-password';
  let sourceDb: Awaited<ReturnType<typeof createDatabase>>;
  let admin: pg.Client;
  let pgConn: string;

  const json = (method: string, path: string, body?: unknown, on = app) =>
    on.request(path, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${owner}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function ok<T>(res: Response | Promise<Response>, expected = 200): Promise<T> {
    const r = await res;
    if (r.status !== expected) throw new Error(`${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }
  async function problem(res: Response | Promise<Response>, expected = 422) {
    const r = await res;
    const text = await r.text();
    if (r.status !== expected) throw new Error(`${r.status}: ${text}`);
    return JSON.parse(text) as { detail?: string };
  }
  async function rows(tableId: string) {
    const meta = await ok<TableMeta>(json('GET', `/api/tables/${tableId}`));
    const { records } = await ok<{ records: RecordT[] }>(
      json('GET', `/api/tables/${tableId}/records?limit=1000`)
    );
    const name = new Map(meta.fields.map((f) => [f.id, f.name]));
    return records
      .map((r) =>
        // Blank cells (null, false) left out, as the API does for most types.
        Object.fromEntries(
          Object.entries(r.fields)
            .filter(([, v]) => v !== null && v !== false && v !== '')
            .map(([id, v]) => [name.get(id) ?? id, v])
        )
      )
      .sort((a, b) => String(a['Sync source']).localeCompare(String(b['Sync source'])));
  }
  /** Queues "Sync now" (unless a run is queued) and runs it as the worker would. */
  async function syncNow(sync: TableSync, with_: SyncSources = sources) {
    let current = await ok<TableSync>(json('GET', `/api/tables/${sync.tableId}/sync`));
    if (!current.runs.some((r) => r.status === 'queued')) {
      current = await ok<TableSync>(json('POST', `/api/tables/${sync.tableId}/sync/run`));
    }
    const queued = current.runs.find((r) => r.status === 'queued');
    if (!queued) throw new Error('no queued run');
    return runSyncJob(
      { db: t.appDb, sources: with_ },
      { workspaceId, syncId: sync.id, runId: queued.id }
    );
  }

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    httpBase = `http://127.0.0.1:${port}`;

    sourceDb = await createDatabase({ template: false });
    admin = new pg.Client({ connectionString: sourceDb.url });
    await admin.connect();
    await admin.query(`
      CREATE TABLE people (id int PRIMARY KEY, name text NOT NULL, active boolean, joined date,
        score numeric(6,2));
      INSERT INTO people VALUES (1, 'Ada', true, '2026-01-02', 9.5), (2, 'Bob', false, null, 7),
        (3, 'Cy', true, '2026-03-04', null);
      CREATE ROLE ${reader} LOGIN PASSWORD '${readerPassword}';
      GRANT SELECT ON people TO ${reader};
    `);
    const u = new URL(sourceDb.url);
    u.username = reader;
    u.password = readerPassword;
    u.search = '?sslmode=disable';
    pgConn = u.toString();
    const dbPort = Number(u.port || 5432);

    // Only this file's servers are allowed, as OUTBOUND_HTTP_ALLOW would on a self-hosted server.
    const outbound: OutboundConfig = {
      allowHttp: true,
      extraPorts: [port, dbPort],
      allow: ['127.0.0.1', u.hostname],
      deny: [],
    };
    const built = testApp({ db: t.appDb });
    encryptionKey = built.config.encryptionKey;
    sources = createSyncSources({ encryptionKey, outbound, requireTls: false });
    app = testApp({ db: t.appDb, syncSources: sources }).app;
    // The default rules: nothing private, https only.
    strictApp = built.app;

    const ws = await createWorkspace(t.db);
    workspaceId = ws.workspace.id;
    owner = await createSession(t.db, ws.owner);
    base = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Imports' }),
      201
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await admin?.end();
    await sourceDb?.drop();
    const cleanup = new pg.Client({ connectionString: inject('pgAdminUrl') });
    await cleanup.connect();
    await cleanup.query(`DROP ROLE IF EXISTS ${reader}`);
    await cleanup.end();
  });

  it('previews a CSV, syncs it, re-runs with a conditional GET and follows changes', async () => {
    const url = `${httpBase}/people.csv`;
    const preview = await ok<SyncPreview>(
      json('POST', `/api/bases/${base.id}/syncs/preview`, { source: { kind: 'csv', url } })
    );
    expect(preview.label).toBe(`${new URL(httpBase).host}/people.csv`);
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'number'],
      ['Name', 'singleLineText'],
      ['Active', 'checkbox'],
    ]);
    expect(preview.rows[0]).toEqual(['1', 'Ada', 'true']);

    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${base.id}/syncs`, {
        source: { kind: 'csv', url },
        columns: [
          { name: 'Name', type: 'singleLineText' },
          { name: 'id', type: 'number', options: { precision: 0 } },
          { name: 'Active', type: 'checkbox' },
        ],
        keyColumn: 'id',
        schedule: 'manual',
      }),
      201
    );
    expect(sync.source).toMatchObject({ kind: 'csv', baseId: null, label: preview.label });
    expect(sync.keyColumn).toBe('id');
    expect(JSON.stringify(sync)).not.toContain('people.csv?');
    // The URL is kept encrypted only.
    const [stored] = await t.db.select().from(tableSyncs).where(eq(tableSyncs.id, sync.id));
    expect(stored?.sourceSecret?.toString('latin1')).not.toContain('people.csv');
    expect(
      stored?.sourceSecret &&
        createCipher(encryptionKey, 'sync-source').decrypt(stored.sourceSecret)
    ).toBe(url);

    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', created: 3 });
    expect(await rows(sync.tableId)).toEqual([
      { Name: 'Ada', id: 1, Active: true, 'Sync source': '1' },
      { Name: 'Bob', id: 2, 'Sync source': '2' },
      { Name: 'Cy', id: 3, Active: true, 'Sync source': '3' },
    ]);

    // Unchanged: a 304, nothing written.
    requests.length = 0;
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', unchanged: 3, created: 0 });
    expect(requests).toEqual([{ path: '/people.csv', ifNoneMatch: '"v1"' }]);

    // Changed: Bob renamed, Cy gone, Dee new; a row without a key is skipped.
    csv = 'id,Name,Active\n1,Ada,true\n2,Robert,false\n4,Dee,\n,Nobody,true\n';
    etag = '"v2"';
    expect(await syncNow(sync)).toMatchObject({
      status: 'succeeded',
      created: 1,
      updated: 1,
      deleted: 1,
      unchanged: 1,
      skipped: 1,
    });
    expect((await rows(sync.tableId)).map((r) => r['Name'])).toEqual(['Ada', 'Robert', 'Dee']);

    // Synced cells stay read-only by hand.
    const res = await json('POST', `/api/tables/${sync.tableId}/records`, {
      records: [{ fields: {} }],
    });
    expect(res.status).toBe(403);
  });

  it('fails a run, keeping the records, when the URL answers a page or loses its columns', async () => {
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${base.id}/syncs`, {
        name: 'From a page',
        source: { kind: 'csv', url: `${httpBase}/html` },
        columns: [{ name: 'id' }],
        keyColumn: null,
        schedule: 'manual',
      }),
      201
    );
    expect(await syncNow(sync)).toEqual({
      status: 'failed',
      error: 'The URL answered with a web page, not a CSV file.',
    });
    const after = await ok<TableSync>(json('GET', `/api/tables/${sync.tableId}/sync`));
    expect(after.runs[0]).toMatchObject({ status: 'failed' });
    expect(after.status).toBe('active');
  });

  it('pauses a CSV past 10,000 rows', async () => {
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${base.id}/syncs`, {
        source: { kind: 'csv', url: `${httpBase}/big.csv` },
        columns: [{ name: 'n' }],
        schedule: 'manual',
      }),
      201
    );
    expect(await syncNow(sync)).toEqual({ status: 'paused', reason: 'too_many_records' });
    expect(await rows(sync.tableId)).toEqual([]);
  });

  it('refuses private, loopback and metadata URLs and redirects to them', async () => {
    for (const url of [
      'https://127.0.0.1/people.csv',
      'https://10.0.0.8/people.csv',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/people.csv',
      'https://localhost/people.csv',
    ]) {
      const preview = await problem(
        json(
          'POST',
          `/api/bases/${base.id}/syncs/preview`,
          { source: { kind: 'csv', url } },
          strictApp
        )
      );
      expect(preview.detail, url).toMatch(/private or reserved address/);
      const created = await problem(
        json(
          'POST',
          `/api/bases/${base.id}/syncs`,
          { source: { kind: 'csv', url }, columns: [{ name: 'a' }] },
          strictApp
        )
      );
      expect(created.detail, url).toMatch(/private or reserved address/);
    }
    // http only where the rules allow it.
    expect(
      (
        await problem(
          json(
            'POST',
            `/api/bases/${base.id}/syncs/preview`,
            { source: { kind: 'csv', url: 'http://example.com/a.csv' } },
            strictApp
          )
        )
      ).detail
    ).toMatch(/Only https URLs are allowed/);
    // A redirect from an allowed server to the metadata address.
    const redirected = await problem(
      json('POST', `/api/bases/${base.id}/syncs/preview`, {
        source: { kind: 'csv', url: `${httpBase}/redirect` },
      })
    );
    expect(redirected.detail).toMatch(/private or reserved address/);
  });

  it('refuses a host that resolves to a private address when the run reads it', async () => {
    // Public at creation, private at the run (DNS rebinding): the run's own check refuses it.
    const answers: ResolvedAddress[] = [{ address: '93.184.215.14', family: 4 }];
    const resolve = async () => answers;
    const policy = outboundPolicy();
    const rebinding: SyncSources = {
      cipher: createCipher(encryptionKey, 'sync-source'),
      http: createSafeFetch(policy, { resolve }),
      urlCheck: createUrlCheck(policy, { resolve }),
      postgres: { hostCheck: createHostCheck(policy, { resolve }), requireTls: true },
      connectors: sources.connectors,
    };
    const rebindApp = testApp({ db: t.appDb, syncSources: rebinding }).app;
    const sync = await ok<TableSync>(
      json(
        'POST',
        `/api/bases/${base.id}/syncs`,
        {
          source: { kind: 'csv', url: 'https://csv.example.com/a.csv' },
          columns: [{ name: 'a' }],
          schedule: 'manual',
        },
        rebindApp
      ),
      201
    );
    answers[0] = { address: '10.1.2.3', family: 4 };
    const outcome = await syncNow(sync, rebinding);
    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.status === 'failed' && outcome.error).toMatch(/private or reserved address/);
    expect(outcome.status === 'failed' && outcome.error).not.toContain('10.1.2.3');
  });

  it('previews and syncs a Postgres table as a read-only role, following changes', async () => {
    const source = { kind: 'postgres', connectionString: pgConn, table: 'public.people' };
    const preview = await ok<SyncPreview>(
      json('POST', `/api/bases/${base.id}/syncs/preview`, { source })
    );
    expect(preview.label).toMatch(/\/test_[0-9a-f]+ · public\.people$/);
    expect(preview.label).not.toContain(readerPassword);
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'number'],
      ['name', 'singleLineText'],
      ['active', 'checkbox'],
      ['joined', 'date'],
      ['score', 'number'],
    ]);

    // The key must be one of the synced columns.
    await problem(
      json('POST', `/api/bases/${base.id}/syncs`, {
        source,
        columns: [{ name: 'name' }],
        keyColumn: 'id',
      })
    );
    const sync = await ok<TableSync>(
      json('POST', `/api/bases/${base.id}/syncs`, {
        source,
        columns: [{ name: 'name' }, ...preview.columns.filter((c) => c.name !== 'name')],
        keyColumn: 'id',
        schedule: 'manual',
      }),
      201
    );
    expect(sync.source.kind).toBe('postgres');
    expect(JSON.stringify(sync)).not.toContain(readerPassword);
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', created: 3 });
    expect(await rows(sync.tableId)).toEqual([
      { name: 'Ada', id: 1, active: true, joined: '2026-01-02', score: 9.5, 'Sync source': '1' },
      { name: 'Bob', id: 2, score: 7, 'Sync source': '2' },
      { name: 'Cy', id: 3, active: true, joined: '2026-03-04', 'Sync source': '3' },
    ]);

    await admin.query(
      "UPDATE people SET name = 'Bobby' WHERE id = 2; DELETE FROM people WHERE id = 3"
    );
    expect(await syncNow(sync)).toMatchObject({
      status: 'succeeded',
      updated: 1,
      deleted: 1,
      unchanged: 1,
    });
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', unchanged: 2, updated: 0 });
    await admin.query("INSERT INTO people VALUES (3, 'Cy', true, '2026-03-04', null)");
  });

  it('syncs one SELECT query and never writes to the source', async () => {
    const preview = await ok<SyncPreview>(
      json('POST', `/api/bases/${base.id}/syncs/preview`, {
        source: {
          kind: 'postgres',
          connectionString: pgConn,
          query: 'SELECT id, upper(name) AS shout FROM people WHERE active ORDER BY id;',
        },
      })
    );
    expect(preview.rows).toEqual([
      ['1', 'ADA'],
      ['3', 'CY'],
    ]);
    // A second statement, a write in a CTE, a write statement: refused, nothing changed.
    for (const query of [
      'SELECT 1; DELETE FROM people',
      'WITH d AS (DELETE FROM people RETURNING *) SELECT * FROM d',
      "SELECT 1) AS x; UPDATE people SET name = 'x'; SELECT (1",
      'DELETE FROM people',
    ]) {
      const res = await problem(
        json('POST', `/api/bases/${base.id}/syncs/preview`, {
          source: { kind: 'postgres', connectionString: pgConn, query },
        })
      );
      expect(res.detail, query).toBeTruthy();
    }
    const { rows: left } = await admin.query('SELECT count(*)::int AS n FROM people');
    expect(left[0]).toEqual({ n: 3 });
    // The read-only role can't read what it wasn't granted.
    await admin.query('CREATE TABLE secrets (v text)');
    const denied = await problem(
      json('POST', `/api/bases/${base.id}/syncs/preview`, {
        source: { kind: 'postgres', connectionString: pgConn, table: 'secrets' },
      })
    );
    expect(denied.detail).toMatch(/permission denied/);
  });

  it('refuses private database hosts, and plain connections where TLS is required', async () => {
    for (const host of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '[::1]', 'localhost']) {
      const res = await problem(
        json(
          'POST',
          `/api/bases/${base.id}/syncs/preview`,
          {
            source: {
              kind: 'postgres',
              connectionString: `postgres://u:p@${host}:5432/db`,
              table: 'people',
            },
          },
          strictApp
        )
      );
      expect(res.detail, host).toMatch(/private or reserved address/);
    }
    const tlsOnly = testApp({
      db: t.appDb,
      syncSources: { ...sources, postgres: { ...sources.postgres, requireTls: true } },
    }).app;
    const res = await problem(
      json(
        'POST',
        `/api/bases/${base.id}/syncs`,
        {
          source: { kind: 'postgres', connectionString: pgConn, table: 'people' },
          columns: [{ name: 'name' }],
        },
        tlsOnly
      )
    );
    expect(res.detail).toMatch(/only connects to databases over TLS/);
    // A wrong password is the database's answer, without the password.
    const wrong = new URL(pgConn);
    wrong.username = 'nobody_here';
    wrong.password = 'not-the-password';
    const denied = await problem(
      json('POST', `/api/bases/${base.id}/syncs/preview`, {
        source: { kind: 'postgres', connectionString: wrong.toString(), table: 'people' },
      })
    );
    // (A trusting test server answers for the role instead: still the database's answer.)
    expect(denied.detail).toMatch(
      /The database answered: .*(password authentication failed|does not exist)/
    );
    expect(denied.detail).not.toContain('not-the-password');
  });
});
