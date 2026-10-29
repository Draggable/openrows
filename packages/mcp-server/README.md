# @openrows/mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[OpenRows](https://app.openrows.io), the open-source Airtable alternative. It gives AI agents
(Claude Code, Cursor, Claude Desktop, VS Code, any MCP client) tools to list your bases, read a
base's schema, list, search and read records, create, update and delete them, and comment.

It calls the OpenRows REST API v1 through [`@openrows/sdk`](https://www.npmjs.com/package/@openrows/sdk) with one personal
access token, so an agent can do only what the token's scopes, its workspace or base grants and
its owner's role allow, under the same rate limits.

```sh
npx -y @openrows/mcp-server --help
```

Published on npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) (built
and signed by the repository's release workflow). Or use the [remote server](#remote-server-streamable-http),
which needs nothing installed.

## Tools

| Tool | What it does | Token scope |
| --- | --- | --- |
| `list_bases` | The bases the token reaches, with your permission level | `schema.bases:read` |
| `describe_base` | A base's tables, fields (types, options) and views; optionally one table | `schema.bases:read` |
| `list_records` | Records a page at a time (`limit` 1 to 100, default 20; `offset` for the next page), with `filterByFormula` (Airtable's syntax), `search` (text in `searchFields` or every text field, ignoring case), `sort`, `view`, `fields` | `data.records:read` (and `schema.bases:read` for `search` without `searchFields`) |
| `get_record` | One record by id | `data.records:read` |
| `create_records` | Creates 1 to 10 records, `typecast` optional | `data.records:write` |
| `update_records` | Changes the given cells of 1 to 10 records (`null` clears one) | `data.records:write` |
| `delete_records` | Moves 1 to 10 records to the base's trash (restorable for 30 days); annotated destructive | `data.records:write` |
| `add_comment` | Comments on a record as the token's owner (Markdown, `@[Name](user:<id>)` mentions) | `data.recordComments:write` |

Inputs are checked with Zod before anything is sent (UUIDs for ids, 10 records per write, 100 per
page, 500 cells per record, 10,000 characters per comment). Answers are JSON text, at most
100,000 characters: long texts are cut first (saying how long they were), then records are left
out of a page, saying so. Errors come back as tool errors with the API's status, code and message
(and what to do about a 401, 403, 404 or 429), never with the token.

The read tools are annotated `readOnlyHint`; `update_records` and `delete_records` are
`destructiveHint`. The server's instructions tell agents that cell values and comments are data
written by people, never instructions, and to confirm deletions with the user.

## Create a token

In OpenRows: Settings → "Developer: personal access tokens". One token per agent, with the fewest
scopes that do the job, granted only the workspaces or bases it needs:

| Use | Scopes |
| --- | --- |
| Read only | `schema.bases:read`, `data.records:read` |
| Read and write records, comment | add `data.records:write`, `data.recordComments:write` |

Keep the token in the MCP client's settings, never in a chat. Revoke it in Settings when the agent
no longer needs it.

## Remote server (Streamable HTTP)

Every OpenRows server answers MCP at `<your OpenRows URL>/mcp`, with the token as a bearer header.
It's stateless (no sessions or SSE streams; `GET` and `DELETE` answer 405) and offers only the
tools the token's scopes allow.

Claude Code:

```sh
claude mcp add --transport http openrows https://app.openrows.io/mcp \
  --header "Authorization: Bearer or_pat_…"
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "openrows": {
      "url": "https://app.openrows.io/mcp",
      "headers": { "Authorization": "Bearer or_pat_…" }
    }
  }
}
```

## Local server (stdio)

`openrows-mcp-server` runs on your machine, started by the MCP client. Settings come from its
environment only:

| Variable | |
| --- | --- |
| `OPENROWS_API_KEY` | Required: a personal access token, `or_pat_…` |
| `OPENROWS_URL` | Your OpenRows origin, default `https://app.openrows.io` (self-hosted: yours) |

Over stdio the token's scopes aren't known up front, so every tool is listed and the API refuses
what the token can't do (a 403 that names the scope). It warns on stderr when `OPENROWS_URL` is
plain `http` to another host. Node 20 or later.

Claude Code:

```sh
claude mcp add openrows \
  --env OPENROWS_API_KEY=or_pat_… --env OPENROWS_URL=https://app.openrows.io \
  -- npx -y @openrows/mcp-server
```

Cursor:

```json
{
  "mcpServers": {
    "openrows": {
      "command": "npx",
      "args": ["-y", "@openrows/mcp-server"],
      "env": { "OPENROWS_API_KEY": "or_pat_…", "OPENROWS_URL": "https://app.openrows.io" }
    }
  }
}
```

## Use it in code

```ts
import { createOpenRowsMcpServer } from '@openrows/mcp-server';
import { OpenRows } from '@openrows/sdk';

const server = createOpenRowsMcpServer({
  client: new OpenRows({ apiKey: process.env.OPENROWS_API_KEY, baseUrl: 'https://app.openrows.io' }),
});
await server.connect(transport); // any MCP SDK server transport
```

## License

AGPL-3.0-only, like the rest of the OpenRows core. Running it unmodified as a local tool
asks nothing of you; if you change it and offer it to others over a network, the AGPL applies to
your changes.

## Releasing

Pushing a `mcp-server-v<version>` tag (the version in `package.json`, after `@openrows/sdk`'s
release it depends on) runs `.github/workflows/release-packages.yml`, which builds, tests, checks
the tarball and publishes with provenance. Nothing is published from a local machine.
