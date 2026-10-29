import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OpenRows } from '@openrows/sdk';
import { createOpenRowsMcpServer } from '../src/server.js';
import type { TokenScope } from '../src/tools.js';

/** A well-formed token no server knows. */
export const TEST_KEY = `or_pat_abcdefghijkl_${'A1b2C3d4E5'.repeat(4)}xyz`;

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** A fetch answering from `routes` (`'GET /api/v1/meta/bases'`), recording every request. */
export function mockFetch(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const request: RecordedRequest = {
      method,
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) {
      return jsonResponse(404, { error: { type: 'NOT_FOUND', message: 'Could not find that.' } });
    }
    return route(request);
  };
  return { fetch, requests };
}

/** An MCP client connected over the SDK's in-memory transport to a server on `fetch`. */
export async function connect(
  fetch: (input: string, init: RequestInit) => Promise<Response>,
  scopes?: TokenScope[]
) {
  const api = new OpenRows({ apiKey: TEST_KEY, baseUrl: 'https://rows.example.com', fetch });
  const server = createOpenRowsMcpServer({
    client: api,
    apiKey: TEST_KEY,
    ...(scopes ? { scopes } : {}),
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** The text of a tool result. */
export const text = (result: CallToolResult) =>
  result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');

/** The JSON a successful tool result carries. */
export const parsed = (result: CallToolResult) =>
  JSON.parse(text(result)) as Record<string, unknown>;
