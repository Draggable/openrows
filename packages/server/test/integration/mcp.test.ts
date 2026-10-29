import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createOpenRowsMcpServer } from '@openrows/mcp-server';
import { OpenRows } from '@openrows/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { users } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createSession,
  createToken,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type App = ReturnType<typeof testApp>['app'];

/** Serves `app` on a random local port. */
async function listen(app: App) {
  let server: ServerType | undefined;
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port)
    );
  });
  const close = () => new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  return { origin: `http://127.0.0.1:${port}`, close };
}

const text = (result: CallToolResult) =>
  result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
const parsed = <T>(result: CallToolResult) => {
  expect(result.isError, text(result)).toBeFalsy();
  return JSON.parse(text(result)) as T;
};

interface Rec {
  id: string;
  fields: Record<string, unknown>;
}

/**
 * The MCP server against the real server and database, as an MCP inspector drives it:
 * the remote endpoint over Streamable HTTP at /mcp, and the stdio server's tools (the same
 * server the `openrows-mcp-server` bin connects to stdin/stdout, whose framing the package's
 * stdio.test.ts covers with the built bin) through the SDK over HTTP. Both get only what the
 * token allows.
 */
describe('the MCP server against the real API', () => {
  const t = useTestDb();
  let http: Awaited<ReturnType<typeof listen>>;
  let owner: User;
  let reader: User;
  let baseId: string;
  let ownerKey: string;
  let readScopesKey: string;
  let readOnlyRoleKey: string;
  let otherTenantKey: string;
  let appUrl: string;

  beforeAll(async () => {
    const { app, config } = testApp({ db: t.appDb });
    http = await listen(app);
    appUrl = config.appUrl;
    const w = await createWorkspace(t.db);
    owner = w.owner;
    reader = await addMember(t.db, w.workspace.id, 'read_only');
    baseId = (await createBase(t.db, w.workspace.id, { name: 'MCP base' })).id;
    ({ token: ownerKey } = await createToken(t.db, owner, { workspaceIds: [w.workspace.id] }));
    ({ token: readScopesKey } = await createToken(t.db, owner, {
      scopes: ['schema.bases:read', 'data.records:read'],
      workspaceIds: [w.workspace.id],
    }));
    ({ token: readOnlyRoleKey } = await createToken(t.db, reader, {
      workspaceIds: [w.workspace.id],
    }));
    const other = await createWorkspace(t.db);
    ({ token: otherTenantKey } = await createToken(t.db, other.owner, {
      workspaceIds: [other.workspace.id],
    }));
    await new OpenRows({ apiKey: ownerKey, baseUrl: http.origin }).tables(baseId).create({
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'singleLineText' },
        { name: 'Notes', type: 'multilineText' },
        { name: 'Points', type: 'number' },
      ],
    });
  });

  afterAll(async () => {
    await http.close();
  });

  /** An MCP client on /mcp over Streamable HTTP with `key` as the bearer token. */
  async function remote(key: string) {
    const client = new Client({ name: 'inspector', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', http.origin), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      })
    );
    return client;
  }

  /** The stdio server's tools, on the SDK over HTTP with `key` (no scopes known up front). */
  async function local(key: string) {
    const server = createOpenRowsMcpServer({
      client: new OpenRows({ apiKey: key, baseUrl: http.origin }),
      apiKey: key,
    });
    const client = new Client({ name: 'inspector', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  }

  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  const table = { table: 'Tasks' };

  async function recordCount() {
    const all = await new OpenRows({ apiKey: ownerKey, baseUrl: http.origin })
      .table(baseId, 'Tasks')
      .select()
      .all();
    return all.length;
  }

  it.each([
    ['Streamable HTTP at /mcp', remote],
    ['the stdio server', local],
  ] as const)(
    'lists, creates, searches, updates, comments and deletes over %s',
    async (_, open) => {
      const client = await open(ownerKey);
      expect(client.getServerVersion()?.name).toBe('openrows');
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'add_comment',
        'create_records',
        'delete_records',
        'describe_base',
        'get_record',
        'list_bases',
        'list_records',
        'update_records',
      ]);

      const { bases } = parsed<{ bases: { id: string; name: string }[] }>(
        await call(client, 'list_bases')
      );
      expect(bases).toEqual([{ id: baseId, name: 'MCP base', permissionLevel: 'owner' }]);

      const schema = parsed<{ tables: { name: string; fields: { name: string }[] }[] }>(
        await call(client, 'describe_base', { baseId })
      );
      expect(schema.tables[0]?.fields.map((f) => f.name)).toEqual(['Name', 'Notes', 'Points']);

      const created = parsed<{ records: Rec[] }>(
        await call(client, 'create_records', {
          baseId,
          ...table,
          records: [
            { fields: { Name: 'Write docs', Points: 3 } },
            { fields: { Name: 'Ship it', Notes: 'Needs the "release" checklist', Points: 5 } },
          ],
        })
      );
      const [docs, ship] = created.records;
      if (!docs || !ship) throw new Error('no records');

      const found = parsed<{ records: Rec[] }>(
        await call(client, 'list_records', {
          baseId,
          ...table,
          search: 'release',
          filterByFormula: '{Points} > 1',
          limit: 10,
        })
      );
      expect(found.records.map((r) => r.id)).toEqual([ship.id]);

      const paged = parsed<{ records: Rec[]; offset?: string }>(
        await call(client, 'list_records', { baseId, ...table, limit: 1, fields: ['Name'] })
      );
      expect(paged.records).toHaveLength(1);
      expect(paged.offset).toBeTruthy();

      parsed(
        await call(client, 'update_records', {
          baseId,
          ...table,
          records: [{ id: docs.id, fields: { Points: 8 } }],
        })
      );
      const got = parsed<{ record: Rec }>(
        await call(client, 'get_record', { baseId, ...table, recordId: docs.id })
      );
      expect(got.record.fields).toEqual({ Name: 'Write docs', Points: 8 });

      const { comment } = parsed<{ comment: { text: string; author: { id: string } } }>(
        await call(client, 'add_comment', { baseId, ...table, recordId: docs.id, text: 'On it' })
      );
      expect(comment).toMatchObject({ text: 'On it', author: { id: owner.id } });

      expect(
        parsed(
          await call(client, 'delete_records', { baseId, ...table, recordIds: [docs.id, ship.id] })
        )
      ).toEqual({
        records: [
          { id: docs.id, deleted: true },
          { id: ship.id, deleted: true },
        ],
      });
      const gone = await call(client, 'get_record', { baseId, ...table, recordId: docs.id });
      expect(gone.isError).toBe(true);
      expect(text(gone)).toContain('404');
      await client.close();
    }
  );

  it('offers a read-only token only the read tools over HTTP, and the API refuses the rest', async () => {
    const before = await recordCount();
    const http = await remote(readScopesKey);
    const { tools } = await http.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'describe_base',
      'get_record',
      'list_bases',
      'list_records',
    ]);
    const args = { baseId, ...table, records: [{ fields: { Name: 'Nope' } }] };
    const refused = await call(http, 'create_records', args);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/create_records not found/);
    parsed(await call(http, 'list_records', { baseId, ...table }));
    await http.close();

    // Over stdio the scopes aren't known up front: every tool is listed, the API says no.
    const stdio = await local(readScopesKey);
    const forbidden = await call(stdio, 'create_records', args);
    expect(forbidden.isError).toBe(true);
    expect(text(forbidden)).toContain('403');
    expect(text(forbidden)).toContain('data.records:write');
    expect(text(forbidden)).not.toContain(readScopesKey);
    const comment = await call(stdio, 'add_comment', {
      baseId,
      ...table,
      recordId: '0195f1a0-0000-7000-8000-0000000000aa',
      text: 'Nope',
    });
    expect(comment.isError).toBe(true);
    await stdio.close();
    expect(await recordCount()).toBe(before);
  });

  it("can't do more than the token owner's role", async () => {
    const before = await recordCount();
    const client = await remote(readOnlyRoleKey);
    const res = await call(client, 'create_records', {
      baseId,
      ...table,
      records: [{ fields: { Name: 'Nope' } }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('403');
    parsed(await call(client, 'list_records', { baseId, ...table }));
    await client.close();
    expect(await recordCount()).toBe(before);
  });

  it("never reaches another tenant's base", async () => {
    const before = await recordCount();
    const client = await remote(otherTenantKey);
    expect(parsed<{ bases: unknown[] }>(await call(client, 'list_bases')).bases).toEqual([]);
    for (const [tool, args] of [
      ['describe_base', { baseId }],
      ['list_records', { baseId, ...table }],
      ['create_records', { baseId, ...table, records: [{ fields: { Name: 'x' } }] }],
    ] as const) {
      const res = await call(client, tool, args);
      expect(res.isError, tool).toBe(true);
      expect(text(res), tool).toContain('404');
    }
    await client.close();
    expect(await recordCount()).toBe(before);
  });

  it('refuses /mcp without a personal access token, and ignores the session cookie', async () => {
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'x', version: '0' },
      },
    };
    const post = (headers: Record<string, string>) =>
      fetch(`${http.origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify(init),
      });
    const anonymous = await post({});
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
    const cookie = await post({
      cookie: `${SESSION_COOKIE}=${await createSession(t.db, owner)}`,
      origin: appUrl,
    });
    expect(cookie.status).toBe(401);
    expect((await post({ authorization: 'Bearer or_pat_nope' })).status).toBe(401);
    const ok = await post({
      authorization: `Bearer ${ownerKey}`,
      origin: 'https://elsewhere.example',
    });
    expect(ok.status).toBe(200);
    // Stateless: no SSE stream to open.
    const stream = await fetch(`${http.origin}/mcp`, {
      headers: { authorization: `Bearer ${ownerKey}`, accept: 'text/event-stream' },
    });
    expect(stream.status).toBe(405);
  });
});
