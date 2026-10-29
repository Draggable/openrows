/**
 * @openrows/mcp-server: OpenRows tools for AI agents over the Model Context Protocol, on
 * the REST API v1 through @openrows/sdk. `openrows-mcp-server` serves them over stdio; the
 * OpenRows server mounts the same tools at `/mcp` (Streamable HTTP).
 *
 * @packageDocumentation
 */
export { ConfigError, loadConfig, type OpenRowsMcpConfig, redact } from './config.js';
export { createOpenRowsMcpServer, INSTRUCTIONS, type OpenRowsMcpServerOptions } from './server.js';
export {
  MAX_BATCH,
  MAX_LIMIT,
  MAX_OUTPUT_CHARS,
  TOOL_SCOPES,
  type TokenScope,
  type ToolName,
} from './tools.js';
export { VERSION } from './version.js';
