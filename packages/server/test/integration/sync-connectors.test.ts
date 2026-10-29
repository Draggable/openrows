import { createHash } from 'node:crypto';
import type {
  Base,
  ConnectorItems,
  RecordData as RecordT,
  SyncConnectorInfo,
  SyncPreview,
  TableMeta,
  TableSync,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { syncConnectorAccounts, tableSyncs } from '../../src/db/index.js';
import { runSyncJob } from '../../src/syncs/run.js';
import {
  ConnectorAuthError,
  type ConnectorTokens,
  type SyncConnector,
} from '../../src/syncs/sources/connectors.js';
import { createSyncSources, type SyncSources } from '../../src/syncs/sources/index.js';
import { SourceError } from '../../src/syncs/sources/types.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Sync connectors: the core's generic plug-in point for sources an edition adds (the
 * hosted Google Sheets lives in the hosted edition). A fake provider stands in for the connector: the connect
 * flow (state, PKCE, the encrypted cookie bound to the user), accounts kept encrypted and only
 * their owner's (RLS), the picker, preview, create, runs with the creator's account (refreshed
 * when expired) and disconnecting (revoked at the provider; the sync pauses).
 */
class FakeProvider {
  challenges = new Map<string, string>();
  grid: (string | null)[][] = [
    ['Name', 'Amount', 'Done'],
    ['Rent', '1200', 'TRUE'],
    ['Food', '300', 'FALSE'],
  ];
  issued = 0;
  revokedTokens: string[] = [];
  live = new Set<string>();
  refreshes = 0;

  connector(): SyncConnector {
    const check = (token: string) => {
      if (!this.live.has(token)) throw new ConnectorAuthError();
    };
    const issue = (): ConnectorTokens => {
      this.issued++;
      const accessToken = `at-${this.issued}`;
      this.live.add(accessToken);
      return { accessToken, refreshToken: 'rt-secret', expiresAt: Date.now() + 3600_000 };
    };
    return {
      id: 'fake-sheets',
      name: 'Fake Sheets',
      description: 'A test provider.',
      levels: ['Spreadsheet', 'Sheet'],
      authorizationUrl: ({ state, codeChallenge, redirectUri }) => {
        this.challenges.set(state, codeChallenge);
        const url = new URL('https://provider.test/authorize');
        url.searchParams.set('state', state);
        url.searchParams.set('redirect_uri', redirectUri);
        return url.href;
      },
      exchangeCode: async (_ctx, { code, codeVerifier }) => {
        const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
        if (code !== 'good-code' || ![...this.challenges.values()].includes(challenge)) {
          throw new ConnectorAuthError('bad code');
        }
        return issue();
      },
      refresh: async (_ctx, tokens) => {
        if (tokens.refreshToken !== 'rt-secret' || this.revokedTokens.includes('rt-secret')) {
          throw new ConnectorAuthError();
        }
        this.refreshes++;
        return issue();
      },
      revoke: async (_ctx, tokens) => {
        this.revokedTokens.push(tokens.refreshToken ?? tokens.accessToken);
        this.live.clear();
      },
      accountLabel: async () => 'ada@example.com',
      browse: async (_ctx, token, { path, search }) => {
        check(token);
        if (path.length === 0) {
          return [{ id: 'budget', name: `Budget${search ? ` (${search})` : ''}`, leaf: false }];
        }
        if (path[0] !== 'budget') throw new SourceError('No such spreadsheet.');
        return [{ id: '0', name: 'Sheet1', detail: '3 rows', leaf: true }];
      },
      describe: async (_ctx, token, source) => {
        check(token);
        if (source.path[0] !== 'budget') throw new SourceError('No such spreadsheet.');
        return { label: 'Budget / Sheet1', tableName: 'Sheet1' };
      },
      read: async (_ctx, token, source) => {
        check(token);
        const header = this.grid[source.headerRow - 1] ?? [];
        return {
          label: 'Budget / Sheet1',
          columns: header.map((h, i) => h ?? `Column ${i + 1}`),
          rows: this.grid.slice(source.headerRow),
        };
      },
    };
  }
}

describe('sync connectors', () => {
  const t = useTestDb();
  const provider = new FakeProvider();
  let app: ReturnType<typeof testApp>['app'];
  let plainApp: ReturnType<typeof testApp>['app'];
  let sources: SyncSources;
  let workspaceId: string;
  let base: Base;
  let ada: { id: string; cookie: string };
  let bob: { id: string; cookie: string };

  const request = (
    method: string,
    path: string,
    who: { cookie: string },
    body?: unknown,
    extraCookie = '',
    on = app
  ) =>
    on.request(path, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${who.cookie}${extraCookie ? `; ${extraCookie}` : ''}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function ok<T>(res: Response | Promise<Response>, expected = 200): Promise<T> {
    const r = await res;
    if (r.status !== expected) throw new Error(`${r.status}: ${await r.text()}`);
    return (expected === 204 ? null : await r.json()) as T;
  }

  /** The connect flow as a browser runs it, up to the redirect back. */
  async function connect(who: { cookie: string }, opts: { code?: string; state?: string } = {}) {
    const start = await request(
      'GET',
      '/api/me/sync-connectors/fake-sheets/connect?returnTo=/b/x?y=1',
      who
    );
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get('location') ?? '');
    expect(location.origin).toBe('https://provider.test');
    expect(location.searchParams.get('redirect_uri')).toMatch(
      /\/api\/me\/sync-connectors\/fake-sheets\/callback$/
    );
    const setCookie = start.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/api\/me\/sync-connectors/);
    const cookie = setCookie.split(';')[0] ?? '';
    const state = opts.state ?? location.searchParams.get('state') ?? '';
    const back = await request(
      'GET',
      `/api/me/sync-connectors/fake-sheets/callback?code=${opts.code ?? 'good-code'}&state=${encodeURIComponent(state)}`,
      who,
      undefined,
      cookie
    );
    expect(back.status).toBe(302);
    return back.headers.get('location');
  }

  async function connectors(who: { cookie: string }) {
    return (
      await ok<{ connectors: SyncConnectorInfo[] }>(request('GET', '/api/me/sync-connectors', who))
    ).connectors;
  }

  async function syncNow(sync: TableSync) {
    let current = await ok<TableSync>(request('GET', `/api/tables/${sync.tableId}/sync`, ada));
    if (!current.runs.some((r) => r.status === 'queued')) {
      current = await ok<TableSync>(request('POST', `/api/tables/${sync.tableId}/sync/run`, ada));
    }
    const queued = current.runs.find((r) => r.status === 'queued');
    if (!queued) throw new Error('no queued run');
    return runSyncJob({ db: t.appDb, sources }, { workspaceId, syncId: sync.id, runId: queued.id });
  }

  async function rows(tableId: string) {
    const meta = await ok<TableMeta>(request('GET', `/api/tables/${tableId}`, ada));
    const { records } = await ok<{ records: RecordT[] }>(
      request('GET', `/api/tables/${tableId}/records?limit=100`, ada)
    );
    const name = new Map(meta.fields.map((f) => [f.id, f.name]));
    return records
      .map((r) =>
        Object.fromEntries(
          Object.entries(r.fields)
            .filter(([, v]) => v !== null && v !== '')
            .map(([id, v]) => [name.get(id) ?? id, v])
        )
      )
      .sort((a, b) => String(a['Name']).localeCompare(String(b['Name'])));
  }

  beforeAll(async () => {
    const built = testApp({ db: t.appDb });
    plainApp = built.app;
    sources = createSyncSources({
      encryptionKey: built.config.encryptionKey,
      outbound: built.config.outbound,
      requireTls: false,
      connectors: [provider.connector()],
    });
    app = testApp({ db: t.appDb, syncSources: sources }).app;
    const ws = await createWorkspace(t.db);
    workspaceId = ws.workspace.id;
    ada = { id: ws.owner.id, cookie: await createSession(t.db, ws.owner) };
    const other = await addMember(t.db, workspaceId, 'creator');
    bob = { id: other.id, cookie: await createSession(t.db, other) };
    base = await ok<Base>(
      request('POST', `/api/workspaces/${workspaceId}/bases`, ada, { name: 'Money' }),
      201
    );
  });

  it('lists nothing and refuses to connect when the edition has no connectors', async () => {
    const res = await ok<{ connectors: unknown[] }>(
      request('GET', '/api/me/sync-connectors', ada, undefined, '', plainApp)
    );
    expect(res.connectors).toEqual([]);
    const start = await request(
      'GET',
      '/api/me/sync-connectors/fake-sheets/connect',
      ada,
      undefined,
      '',
      plainApp
    );
    expect(start.status).toBe(404);
  });

  it('refuses a callback whose state or code is wrong, or that has no flow cookie', async () => {
    expect(await connect(bob, { state: 'forged' })).toBe(
      '/b/x?y=1&syncConnector=fake-sheets&connected=0'
    );
    expect(await connect(bob, { code: 'bad-code' })).toBe(
      '/b/x?y=1&syncConnector=fake-sheets&connected=0'
    );
    const bare = await request(
      'GET',
      '/api/me/sync-connectors/fake-sheets/callback?code=good-code&state=x',
      bob
    );
    expect(bare.headers.get('location')).toBe('/?syncConnector=fake-sheets&connected=0');
    expect((await connectors(bob))[0]?.account).toBeNull();
  });

  it("connects an account, keeps its tokens encrypted and only its owner's", async () => {
    expect((await connectors(ada))[0]).toMatchObject({ id: 'fake-sheets', account: null });
    expect(await connect(ada)).toBe('/b/x?y=1&syncConnector=fake-sheets&connected=1');
    const [info] = await connectors(ada);
    expect(info).toMatchObject({
      name: 'Fake Sheets',
      levels: ['Spreadsheet', 'Sheet'],
      account: { label: 'ada@example.com' },
    });
    // Encrypted at rest.
    const [row] = await t.db.select().from(syncConnectorAccounts);
    expect(row?.tokensEncrypted.toString('latin1')).not.toContain('rt-secret');
    // RLS: someone else's scope sees no account, and can't write one for Ada.
    const seen = await inScope(t.appDb, { userId: bob.id }, (tx) =>
      tx.select().from(syncConnectorAccounts)
    );
    expect(seen).toEqual([]);
    await expect(
      inScope(t.appDb, { userId: bob.id }, (tx) =>
        tx.execute(sql`UPDATE sync_connector_accounts SET label = 'x' WHERE user_id = ${ada.id}`)
      )
    ).resolves.toMatchObject({ rowCount: 0 });
    // Bob has no account: his picker is a 422.
    const res = await request('POST', `/api/bases/${base.id}/syncs/browse`, bob, {
      connector: 'fake-sheets',
      path: [],
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Connect your Fake Sheets account first.');
  });

  it('browses, previews, creates and runs a sync with the creator’s account', async () => {
    const top = await ok<ConnectorItems>(
      request('POST', `/api/bases/${base.id}/syncs/browse`, ada, {
        connector: 'fake-sheets',
        path: [],
        search: 'bud',
      })
    );
    expect(top.items).toEqual([{ id: 'budget', name: 'Budget (bud)', detail: null, leaf: false }]);
    const sheets = await ok<ConnectorItems>(
      request('POST', `/api/bases/${base.id}/syncs/browse`, ada, {
        connector: 'fake-sheets',
        path: ['budget'],
      })
    );
    expect(sheets.items).toEqual([{ id: '0', name: 'Sheet1', detail: '3 rows', leaf: true }]);
    // Nothing below a sheet.
    expect(
      (
        await request('POST', `/api/bases/${base.id}/syncs/browse`, ada, {
          connector: 'fake-sheets',
          path: ['budget', '0'],
        })
      ).status
    ).toBe(422);

    const source = { kind: 'connector', connector: 'fake-sheets', path: ['budget', '0'] };
    const preview = await ok<SyncPreview>(
      request('POST', `/api/bases/${base.id}/syncs/preview`, ada, { source })
    );
    expect(preview.label).toBe('Budget / Sheet1');
    expect(preview.columns.map((c) => [c.name, c.type])).toEqual([
      ['Name', 'singleLineText'],
      ['Amount', 'number'],
      ['Done', 'checkbox'],
    ]);
    // A path that stops short is refused.
    const short = await request('POST', `/api/bases/${base.id}/syncs/preview`, ada, {
      source: { ...source, path: ['budget'] },
    });
    expect(short.status).toBe(422);
    // Unknown connectors too.
    const unknown = await request('POST', `/api/bases/${base.id}/syncs/preview`, ada, {
      source: { ...source, connector: 'nope' },
    });
    expect(unknown.status).toBe(422);

    const sync = await ok<TableSync>(
      request('POST', `/api/bases/${base.id}/syncs`, ada, {
        source,
        columns: preview.columns,
        keyColumn: 'Name',
        schedule: 'hourly',
      }),
      201
    );
    expect(sync.source).toMatchObject({
      kind: 'connector',
      connector: 'fake-sheets',
      label: 'Budget / Sheet1',
    });
    const [stored] = await t.db.select().from(tableSyncs).where(eq(tableSyncs.id, sync.id));
    expect(stored?.sourceSecret).toBeNull();
    expect(stored?.sourceConfig).toEqual({
      connector: 'fake-sheets',
      path: ['budget', '0'],
      headerRow: 1,
    });

    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', created: 2 });
    expect(await rows(sync.tableId)).toEqual([
      expect.objectContaining({ Name: 'Food', Amount: 300 }),
      expect.objectContaining({ Name: 'Rent', Amount: 1200, Done: true }),
    ]);

    // The sheet changes; an expired access token is refreshed and kept.
    provider.grid = [
      ['Name', 'Amount', 'Done'],
      ['Rent', '1250', 'TRUE'],
    ];
    await t.db
      .update(syncConnectorAccounts)
      .set({
        tokensEncrypted: sources.connectors.cipher.encrypt(
          JSON.stringify({ accessToken: 'at-1', refreshToken: 'rt-secret', expiresAt: 0 })
        ),
      })
      .where(eq(syncConnectorAccounts.userId, ada.id));
    expect(await syncNow(sync)).toMatchObject({ status: 'succeeded', updated: 1, deleted: 1 });
    expect(provider.refreshes).toBe(1);
    expect(await rows(sync.tableId)).toEqual([expect.objectContaining({ Amount: 1250 })]);

    // Disconnecting revokes at the provider; the next run pauses (lost access).
    await ok(request('DELETE', '/api/me/sync-connectors/fake-sheets', ada), 204);
    expect(provider.revokedTokens).toEqual(['rt-secret']);
    expect((await connectors(ada))[0]?.account).toBeNull();
    expect(await syncNow(sync)).toEqual({ status: 'paused', reason: 'access_lost' });
    const after = await ok<TableSync>(request('GET', `/api/tables/${sync.tableId}/sync`, ada));
    expect(after.pauseReason).toBe('access_lost');
    // The records stay.
    expect(await rows(sync.tableId)).toHaveLength(1);
    // A second disconnect finds nothing.
    expect((await request('DELETE', '/api/me/sync-connectors/fake-sheets', ada)).status).toBe(404);
  });
});
