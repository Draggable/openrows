# MCP server

AI agents use OpenRows through the Model Context Protocol, two ways, with the same tools:

- **Remote:** `POST /mcp` on the API (Streamable HTTP, stateless, JSON answers), for personal
  access tokens only (`src/mcp/routes.ts`, the `token` access rule of the route registry). The
  tools call the REST API v1 through `@openrows/sdk` with the caller's own token, sent back into
  the app in process (`app.request`, no network hop), so each call passes the same
  `authorize()`, RLS, edit permissions and rate limits as the token calling `/api/v1` itself
  (an MCP request costs one request of the token's bucket plus one per API call). Only the
  tools the token's scopes allow are listed.
- **Local:** `packages/mcp-server`, `openrows-mcp-server` over stdio, configured by
  `OPENROWS_API_KEY` and `OPENROWS_URL`. Published on npm as `@openrows/mcp-server` with
  provenance, so MCP clients start it with `npx -y @openrows/mcp-server`
  (`npx -y @openrows/mcp-server --help` prints the settings).

## Releases

`.github/workflows/release-packages.yml` publishes `@openrows/sdk`, `@openrows/mcp-server` and
`@openrows/n8n-nodes-openrows` on a pushed `sdk-v<version>`, `mcp-server-v<version>` or
`n8n-v<version>` tag: the tag must name the package's version and a commit on main, `NPM_TOKEN`
must be set, the package's tests and `npm run check:packages` (the tarball holds only `dist/`,
README, LICENSE and package.json) must pass, then `npm publish --provenance --access public`
from a GitHub-hosted runner. The MCP server depends on the SDK by a caret range, so a release of
both tags the SDK first. Nothing is published from a local machine.

Users' guide: [packages/mcp-server/README.md](../../packages/mcp-server/README.md) and the
`/docs/api/mcp` page (snippets with the server's own URL). `GET /llms.txt` lists the docs for
agents.

## Tests

- `packages/mcp-server/src/tools.test.ts`: every tool through an in-memory MCP client against a
  fake fetch (requests, Zod refusals, errors, size caps, scope filtering).
- `packages/mcp-server/src/stdio.test.ts`: the built bin over real stdio with the SDK's
  `StdioClientTransport` (as Claude Code starts it) against a fake API: lists tools and bases,
  updates records, never prints the token.
- `packages/server/test/integration/mcp.test.ts`: real Postgres, the server on a random port;
  the inspector-style flow (list, describe, create, search, page, update, get, comment, delete)
  over Streamable HTTP at `/mcp` and through the stdio server's tools; a read-only token (only
  the read tools over HTTP, 403 over stdio, nothing written); a read-only member's token; another
  tenant's token (404s); no token, a session cookie or a bad token (401).
- `authz-matrix.test.ts`: `POST/GET/DELETE /mcp` and `GET /llms.txt`.

## Manual check: Claude Code lists and updates records

Run against the dev stack (`docker/compose.sh dev up -d --wait`, app on http://localhost:8180)
or app.openrows.io:

1. Sign in, open a base with a table (or `npm run db:seed -- --email <you>` for the demo
   workspace), and create a personal access token in Settings → "Developer: personal access
   tokens" with `schema.bases:read`, `data.records:read` and `data.records:write`.
2. Remote: `claude mcp add --transport http openrows http://localhost:8180/mcp --header
   "Authorization: Bearer <token>"`. Local instead, from npm: `claude mcp add openrows --env
   OPENROWS_API_KEY=<token> --env OPENROWS_URL=http://localhost:8180 -- npx -y
   @openrows/mcp-server` (or, to try a change from a checkout, `npm run build -w
   @openrows/mcp-server` and `node packages/mcp-server/dist/bin.js` in place of `npx -y …`).
3. `claude mcp list` shows `openrows` connected; in a session, `/mcp` lists its 8 tools (7 with
   the remote server and this token: no `add_comment`).
4. Ask: "List my OpenRows bases, then show the first 5 records of the Tasks table" (Claude calls
   `list_bases`, `describe_base`, `list_records`). Then: "Set the Status of the first one to
   Done" (`update_records`). The grid shows the change live.
5. With a read-only token (no `data.records:write`), ask for a change: the remote server has no
   write tools; the local one answers a 403 naming `data.records:write`.
6. `claude mcp remove openrows` and revoke the token.

The automated equivalent of steps 2 to 5 is `mcp.test.ts` and `stdio.test.ts` above (the same
MCP SDK client Claude Code uses, over the same transports).
