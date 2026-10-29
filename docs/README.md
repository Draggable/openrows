# OpenRows documentation

The user guide, the self-hosting guide and the API docs below are also published at
[openrows.io/docs](https://openrows.io/docs), with search. Every OpenRows server also serves its
own API reference at `/docs/api`, its OpenAPI document at `/api/openapi.json` and an `llms.txt`
for AI agents.

## User guide

- [Getting started](guide/getting-started.md): sign in, workspaces and bases, your first base,
  shortcuts
- [Bases, tables and records](guide/bases-and-tables.md): editing, comments, history, import,
  export, snapshots
- [Fields](guide/fields.md): every field type, links, lookups, rollups and formulas, edit
  permissions
- [Views](guide/views.md): grid, kanban, calendar, gallery, timeline, list and form
- [Sharing and permissions](guide/sharing.md): roles, base collaborators, share links and embeds
- [Forms](guide/forms.md): public forms and their submissions
- [Automations](guide/automations.md): triggers, actions, test runs and run history
- [Scripts](guide/scripts.md): JavaScript against a base, in a browser sandbox
- [Extensions](guide/extensions.md): the extension panel and building your own
- [Moving from Airtable](guide/airtable-migration.md): the importer and what maps to what

## Self-hosting

- [Self-hosting](guide/self-hosting.md): Docker Compose and Kubernetes (Helm), configuration,
  sign-in, storage, email, backups, upgrades, security
- [Database roles and row-level security](deploy/database.md)
- [Keycloak settings](deploy/keycloak.md): the realm and client OpenRows needs
- [Run-script automation steps](deploy/automation-scripts.md): what turning them on means
- [The Docker image and Compose stacks](../docker/README.md)
- [The Helm chart](../deploy/helm/openrows/README.md)

## API and integrations

- [REST API v1](api/v1.md): Airtable's Web API shape, tokens, records, `filterByFormula`
- [Webhooks](api/webhooks.md): signed deliveries, retries, the delivery log
- [OAuth apps](api/oauth.md): authorization code with PKCE, scopes, refresh tokens
- [MCP server](api/mcp.md): tools for AI agents, remote and stdio
- [JavaScript SDK](../packages/sdk/README.md), [MCP server package](../packages/mcp-server/README.md),
  [n8n nodes](../packages/n8n-nodes-openrows/README.md),
  [extensions SDK](../packages/blocks/README.md)

## Architecture

- [Architecture decision records](adr/README.md): record storage, tenancy, realtime, jobs, open
  core, sign-in, grid rendering
- [Design direction](design/DESIGN.md): the "Ledger" design tokens and the brand

## Hosted service

These features of [app.openrows.io](https://app.openrows.io) aren't part of the open-source
code; their guides live on the website: [single sign-on](https://openrows.io/docs/single-sign-on),
[SCIM provisioning](https://openrows.io/docs/scim-provisioning),
[audit log](https://openrows.io/docs/audit-log),
[admin console](https://openrows.io/docs/admin-console), [Zapier](https://openrows.io/docs/zapier)
and [Make](https://openrows.io/docs/make). Plans and prices: [openrows.io/pricing](https://openrows.io/pricing).
Legal: [privacy](https://openrows.io/privacy), [terms](https://openrows.io/terms).
