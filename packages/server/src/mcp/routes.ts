import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createOpenRowsMcpServer } from '@openrows/mcp-server';
import { OpenRows } from '@openrows/sdk';
import type { Context } from 'hono';
import type { SessionEnv } from '../auth/middleware.js';
import type { RouteRegistry } from '../authz/routes.js';
import { AppError } from '../lib/errors.js';

export const MCP_PATH = '/mcp';
/** The largest JSON-RPC request body: the biggest tool call is 10 records of cells. */
export const MCP_BODY_MAX = 1024 * 1024;

/**
 * The remote MCP endpoint: the @openrows/mcp-server tools over Streamable HTTP, stateless
 * (a server per request, JSON answers, no sessions or SSE streams), for personal access tokens
 * only. The tools call the REST API v1 through @openrows/sdk with the caller's own token, sent
 * back into this app in process (no network hop), so every call passes the same `authorize()`,
 * RLS, edit permissions and rate limits as the token calling /api/v1 itself. Only the tools the
 * token's scopes allow are offered.
 */
export function mcpRoutes(routes: RouteRegistry, deps: { appUrl: string }): void {
  const handle = async (c: Context<SessionEnv>) => {
    const { token } = c.var.principal;
    const apiKey = c.req
      .header('authorization')
      ?.replace(/^Bearer\s+/i, '')
      .trim();
    // The token rule guarantees both; this keeps the types honest.
    if (!token || !apiKey) throw new AppError('UNAUTHENTICATED');
    const app = routes.app;
    const client = new OpenRows({
      apiKey,
      baseUrl: deps.appUrl,
      // Back into this app with the original connection, so the client IP is the caller's.
      fetch: async (url, init) => app.request(url, init, c.env),
      // A 429 goes back to the agent, which is told how long to wait.
      maxRetries: 0,
    });
    const server = createOpenRowsMcpServer({ client, scopes: token.scopes, apiKey });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MCP_BODY_MAX,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  };
  routes.token('POST', MCP_PATH, handle);
  // Stateless: no SSE stream to open and no session to end, so GET and DELETE are 405, as the
  // Streamable HTTP transport allows.
  const notAllowed = (c: Context<SessionEnv>) =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
      405,
      { Allow: 'POST' }
    );
  routes.token('GET', MCP_PATH, notAllowed);
  routes.token('DELETE', MCP_PATH, notAllowed);
}
