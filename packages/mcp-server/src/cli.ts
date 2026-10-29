import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OpenRows } from '@openrows/sdk';
import { ConfigError, isInsecureUrl, loadConfig, redact } from './config.js';
import { createOpenRowsMcpServer } from './server.js';
import { VERSION } from './version.js';

export const HELP = `openrows-mcp-server ${VERSION}

The OpenRows MCP server: OpenRows tools for AI agents over stdio. Your MCP client starts it
and talks to it on stdin/stdout.

Usage:
  openrows-mcp-server              Serve MCP over stdio
  openrows-mcp-server --help       Show this help
  openrows-mcp-server --version    Print the version

Environment:
  OPENROWS_API_KEY   (required) A personal access token, or_pat_...
  OPENROWS_URL       Your OpenRows origin (default https://app.openrows.io)

Docs: https://app.openrows.io/docs/api/mcp
`;

export type CliAction = 'serve' | 'help' | 'version' | { error: string };

/** What the command line asks for. Settings come from the environment only. */
export function parseArgs(args: readonly string[]): CliAction {
  if (args.includes('--help') || args.includes('-h')) return 'help';
  if (args.includes('--version') || args.includes('-v')) return 'version';
  if (args.length === 0) return 'serve';
  return {
    error: `unknown argument ${JSON.stringify(redact(args[0] ?? ''))}; settings come from OPENROWS_API_KEY and OPENROWS_URL (see --help).`,
  };
}

/** stdout carries the protocol: everything else goes to stderr, never with the token. */
export async function main(): Promise<void> {
  const action = parseArgs(process.argv.slice(2));
  if (action === 'help' || action === 'version') {
    process.stdout.write(action === 'help' ? HELP : `${VERSION}\n`);
    return;
  }
  if (typeof action === 'object') {
    console.error(`openrows-mcp-server: ${action.error}`);
    process.exit(2);
  }
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`openrows-mcp-server: ${error.message}`);
    process.exit(1);
  }
  if (isInsecureUrl(config.url)) {
    console.error(
      `openrows-mcp-server: warning: ${config.url} is plain http, so the token is sent unencrypted.`
    );
  }
  const client = new OpenRows({
    apiKey: config.apiKey,
    baseUrl: config.url,
    headers: { 'User-Agent': `openrows-mcp-server/${VERSION}` },
  });
  const server = createOpenRowsMcpServer({ client, apiKey: config.apiKey });
  await server.connect(new StdioServerTransport());
  console.error(`openrows-mcp-server: ready (${config.url})`);
  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
