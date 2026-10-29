import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * lib/safe-fetch/ is the only way server code makes HTTP requests. Anything else that can
 * open an outbound connection (global fetch, undici, node:http(s) clients, raw sockets, HTTP
 * client libraries) fails this test, except the files below, which only talk to destinations
 * the operator configured, never a URL a user typed.
 */
const ALLOWED: Record<string, { modules: string[]; why: string }> = {
  'health.ts': {
    modules: ['node:net', 'node:tls', 'aws4fetch'],
    why: '/ready probes the configured Postgres, Redis, S3 and SMTP',
  },
  'attachments/storage.ts': { modules: ['aws4fetch'], why: 'the configured S3 bucket' },
  'attachments/scan.ts': { modules: ['node:net'], why: 'the configured clamd (CLAMAV_URL, #133)' },
  'forms/turnstile.ts': {
    modules: ['fetch'],
    why: "Cloudflare Turnstile's fixed siteverify URL",
  },
  'email/transport.ts': { modules: ['nodemailer'], why: 'the configured SMTP relay' },
  'automations/script/bridge.ts': {
    modules: ['fetch'],
    why: "a script's `fetch` call (#112), answered through the SSRF-safe client (env.http)",
  },
  'automations/script/runner.ts': {
    modules: ['fetch'],
    why: "the script's `fetch` inside the sandbox (#112): a call over stdio, the sandbox has no network",
  },
  'db/index.ts': { modules: ['pg'], why: 'the configured DATABASE_URL' },
  'db/migrate.ts': { modules: ['pg'], why: 'the configured MIGRATION_DATABASE_URL' },
  'indexes/sync.ts': { modules: ['pg'], why: 'the configured INDEX_DATABASE_URL' },
  'realtime/bus.ts': { modules: ['pg'], why: 'LISTEN on the configured database' },
  'syncs/sources/postgres.ts': {
    modules: ['pg'],
    why: 'a Postgres sync source (#155): only the address createHostCheck pinned by these rules',
  },
  'mcp/routes.ts': {
    modules: ['fetch'],
    why: "the MCP tools' SDK `fetch` is app.request: back into this app, never the network",
  },
};

/** Modules that make outbound connections, and the imports from them that don't. */
const NETWORK: Record<string, Set<string>> = {
  undici: new Set(),
  'node-fetch': new Set(),
  axios: new Set(),
  got: new Set(),
  ky: new Set(),
  superagent: new Set(),
  'cross-fetch': new Set(),
  aws4fetch: new Set(),
  nodemailer: new Set(),
  'node:http': new Set(['createServer', 'STATUS_CODES', 'IncomingMessage', 'ServerResponse']),
  'node:https': new Set(),
  'node:http2': new Set(),
  'node:net': new Set(['isIP', 'isIPv4', 'isIPv6', 'BlockList', 'SocketAddress']),
  'node:tls': new Set(),
  'node:dgram': new Set(),
  ws: new Set(['WebSocketServer']),
  // Postgres clients (a sync source's database is user-chosen).
  pg: new Set(),
};
for (const name of ['http', 'https', 'http2', 'net', 'tls', 'dgram']) {
  NETWORK[name] = NETWORK[`node:${name}`] ?? new Set();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** What `source` uses to reach the network: module names, and `fetch` for the global one. */
function networkUses(source: string): string[] {
  const code = stripComments(source);
  const uses = new Set<string>();
  const imports = /import\s+(?!type\b)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const [, clause = '', module = ''] of code.matchAll(imports)) {
    const safe = NETWORK[module];
    if (!safe) continue;
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    const names = named
      ? (named[1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith('type '))
          .map((s) => s.split(/\s+as\s+/)[0] ?? s)
      : ['*'];
    if (names.some((n) => !safe.has(n))) uses.add(module);
  }
  for (const [, module = ''] of code.matchAll(/(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (NETWORK[module]) uses.add(module);
  }
  if (/(?<![.#\w$])fetch\s*\(|\bglobalThis\.fetch\b|[=(,:]\s*fetch\b(?!\s*\()/.test(code)) {
    uses.add('fetch');
  }
  return [...uses].sort();
}

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const OWN = fileURLToPath(new URL('./', import.meta.url));

describe('outbound HTTP boundary (#106)', () => {
  it('recognizes the ways to reach the network', () => {
    expect(networkUses("const r = await fetch('https://x');")).toEqual(['fetch']);
    expect(networkUses('const f = globalThis.fetch;')).toEqual(['fetch']);
    expect(networkUses('function f(impl = fetch) {}')).toEqual(['fetch']);
    expect(networkUses("import { request } from 'undici';")).toEqual(['undici']);
    expect(networkUses("import * as https from 'node:https';")).toEqual(['node:https']);
    expect(networkUses("import http from 'http';")).toEqual(['http']);
    expect(networkUses("import { createConnection } from 'node:net';")).toEqual(['node:net']);
    expect(networkUses("import { WebSocket } from 'ws';")).toEqual(['ws']);
    expect(networkUses("const u = await import('undici');")).toEqual(['undici']);
    // Not network access:
    expect(networkUses("import { isIP } from 'node:net';")).toEqual([]);
    expect(networkUses("import type { Agent } from 'node:https';")).toEqual([]);
    expect(networkUses("import { createServer, type Server } from 'node:http';")).toEqual([]);
    expect(networkUses('this.#fetch(id); client.fetch(url); // fetch(x)')).toEqual([]);
    expect(networkUses('/* fetch(url) */ const refetch = () => 1;')).toEqual([]);
  });

  it('allows outbound requests only in lib/safe-fetch and the listed files', () => {
    const offenders: string[] = [];
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')
    );
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const path = join(SRC, file);
      if (!relative(OWN, path).startsWith('..')) continue;
      const name = file.split('\\').join('/');
      const allowed = new Set(ALLOWED[name]?.modules ?? []);
      const uses = networkUses(readFileSync(path, 'utf8'));
      for (const use of uses) {
        if (!allowed.has(use)) offenders.push(`${name}: ${use}`);
      }
      // Keep the list tight: an entry the file no longer needs goes.
      for (const module of allowed) {
        if (!uses.includes(module)) offenders.push(`${name}: ${module} is allowed but unused`);
      }
    }
    expect(
      offenders,
      'Use createSafeFetch from lib/safe-fetch for requests to user-chosen URLs'
    ).toEqual([]);
  });
});
