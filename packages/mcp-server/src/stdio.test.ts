import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_KEY } from '../test/helpers.js';
import { VERSION } from './version.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const BIN = `${DIR}dist/bin.js`;
const BASE = '0195f1a0-0000-7000-8000-000000000001';
const REC = '0195f1a0-0000-7000-8000-0000000000aa';

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });

/**
 * The built `openrows-mcp-server` bin over real stdio, as an MCP client (Claude Code, Cursor)
 * starts it, against a fake OpenRows API on a random port. Build first:
 * `npm run build -w @openrows/mcp-server`.
 */
describe('openrows-mcp-server over stdio', () => {
  let api: Server;
  let url: string;
  const seen: { method: string; path: string; auth: string; body: string }[] = [];

  beforeAll(async () => {
    expect(existsSync(BIN), 'build first: npm run build -w @openrows/mcp-server').toBe(true);
    api = createServer(async (req, res) => {
      const text = await body(req);
      const path = req.url ?? '';
      seen.push({
        method: req.method ?? '',
        path,
        auth: req.headers.authorization ?? '',
        body: text,
      });
      res.setHeader('content-type', 'application/json');
      if (path === '/api/v1/meta/bases') {
        res.end(
          JSON.stringify({ bases: [{ id: BASE, name: 'Roadmap', permissionLevel: 'edit' }] })
        );
      } else if (req.method === 'PATCH' && path === `/api/v1/${BASE}/Tasks`) {
        const { records } = JSON.parse(text) as { records: { id: string; fields: object }[] };
        res.end(
          JSON.stringify({
            records: records.map((r) => ({ ...r, createdTime: '2026-10-27T00:00:00.000Z' })),
          })
        );
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { type: 'NOT_FOUND', message: 'Could not find that.' } }));
      }
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => api.close(() => resolve())));

  it('lists tools, lists bases and updates records', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { OPENROWS_API_KEY: TEST_KEY, OPENROWS_URL: url, PATH: process.env['PATH'] ?? '' },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    expect(client.getServerVersion()).toMatchObject({ name: 'openrows', version: VERSION });
    expect(client.getInstructions()).toContain('list_bases');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('update_records');

    const bases = (await client.callTool({ name: 'list_bases' })) as CallToolResult;
    expect(bases.isError).toBeFalsy();
    expect(JSON.stringify(bases.content)).toContain('Roadmap');

    const updated = (await client.callTool({
      name: 'update_records',
      arguments: { baseId: BASE, table: 'Tasks', records: [{ id: REC, fields: { Done: true } }] },
    })) as CallToolResult;
    expect(updated.isError).toBeFalsy();
    expect(seen.at(-1)).toMatchObject({
      method: 'PATCH',
      path: `/api/v1/${BASE}/Tasks`,
      auth: `Bearer ${TEST_KEY}`,
    });

    await client.close();
    expect(stderr).toContain('ready');
    expect(stderr).not.toContain(TEST_KEY);
  });

  it('exits with a clear message without a token', () => {
    let message = '';
    try {
      execFileSync(process.execPath, [BIN], {
        env: { PATH: process.env['PATH'] ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      message = String((error as { stderr: Buffer }).stderr);
    }
    expect(message).toContain('OPENROWS_API_KEY is not set');
  });

  it('prints its version, the same as package.json', () => {
    const pkg = JSON.parse(readFileSync(`${DIR}package.json`, 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }).trim()).toBe(
      pkg.version
    );
  });
});
