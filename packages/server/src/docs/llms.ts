import { BRAND } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';

/**
 * `/llms.txt` (https://llmstxt.org): what OpenRows is and where an AI agent finds the API
 * reference, the SDK and the MCP server, as Markdown with this server's own URLs, then the
 * project's user guide, self-hosting guide and source code. Public, like the OpenAPI document: it
 * says what exists, never anyone's data.
 */
export function llmsTxt(appUrl: string): string {
  return `# ${BRAND}

> ${BRAND} is an open-source (AGPL-3.0) Airtable alternative: workspaces hold bases, bases hold tables of records with typed fields (text, numbers, selects, dates, attachments, users, links, lookups, rollups, formulas, AI fields) and views (grid, kanban, calendar, gallery, timeline, list, form), with interfaces, automations, webhooks, realtime collaboration and a REST API in Airtable's shape. This server is ${appUrl}.

Programs and AI agents use ${BRAND} with a personal access token (\`Authorization: Bearer or_pat_…\`), created in Settings → "Developer: personal access tokens". A token can do only what its scopes, its workspace or base grants and its owner's role allow. Integrations that act for other people register an OAuth app instead.

## API

- [REST API v1 guide](${appUrl}/docs/api): Airtable's Web API shape (\`/api/v1/{baseId}/{tableIdOrName}\`), so Airtable clients work with a base URL change
- [OpenAPI document](${appUrl}/api/openapi.json): every operation and schema
- [Moving from Airtable](${appUrl}/docs/api/from-airtable): what differs from Airtable's API
- [Webhooks](${appUrl}/docs/api#webhooks): a base's changes sent to your URL as signed JSON

## Tools

- [MCP server](${appUrl}/docs/api/mcp): tools for AI agents (list bases, describe a base, list/search, get, create, update and delete records, comment). Remote: Streamable HTTP at \`${appUrl}/mcp\` with the token as a bearer header. Local: \`npx -y @openrows/mcp-server\` with \`OPENROWS_API_KEY\` and \`OPENROWS_URL=${appUrl}\`
- [JavaScript SDK](${appUrl}/docs/api/sdk): \`@openrows/sdk\`, a typed client of the REST API v1
- [n8n nodes](${appUrl}/docs/api#n8n): \`@openrows/n8n-nodes-openrows\`, an ${BRAND} node (records) and an ${BRAND} Trigger (signed webhooks) for n8n

## Docs

- [User guide](https://openrows.io/docs): bases, fields, views, sharing, forms, automations, scripts, extensions
- [Moving from Airtable](https://openrows.io/docs/airtable-migration): the importer and what maps to what
- [Self-hosting](https://openrows.io/docs/self-hosting): Docker Compose or Kubernetes (Helm)
- [OAuth apps](https://openrows.io/docs/api/oauth): authorization code with PKCE, scopes, refresh tokens

## Optional

- [Source code](https://github.com/Draggable/openrows): the AGPL-3.0 core, with the docs as Markdown
- [${BRAND} website](https://openrows.io): the project, the hosted service and its pricing
`;
}

export function docsRoutes(routes: RouteRegistry, deps: { appUrl: string }): void {
  const body = llmsTxt(deps.appUrl);
  routes.public('GET', '/llms.txt', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.text(body, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  });
}
