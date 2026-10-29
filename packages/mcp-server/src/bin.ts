#!/usr/bin/env node
import { main } from './cli.js';
import { redact } from './config.js';

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`openrows-mcp-server: ${redact(message, process.env['OPENROWS_API_KEY']?.trim())}`);
  process.exit(1);
});
