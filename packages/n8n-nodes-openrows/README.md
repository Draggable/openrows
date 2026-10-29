# @openrows/n8n-nodes-openrows

[n8n](https://n8n.io) community nodes for [OpenRows](https://app.openrows.io), the open-source
Airtable alternative:

- **OpenRows**: records of a table through the REST API v1: get, get many, search, create, update,
  create or update (upsert) and delete.
- **OpenRows Trigger**: starts a workflow when records, fields or tables of a base change, through
  a signed [webhook](https://github.com/Draggable/openrows/blob/main/docs/api/webhooks.md) it registers on activation and deletes on
  deactivation.

## Installing

In a self-hosted n8n (1.x or later, community packages allowed): **Settings → Community nodes →
Install**, enter `@openrows/n8n-nodes-openrows`, accept the risk prompt and install. The nodes
then show up as **OpenRows** and **OpenRows Trigger**. Without the UI (queue mode, Docker images
you build):

```sh
# in n8n's user folder, e.g. ~/.n8n/nodes or /home/node/.n8n/nodes in the official image
npm install @openrows/n8n-nodes-openrows
```

and restart n8n. The package is published on npm with provenance and has no runtime
dependencies (`n8n-workflow` is a peer dependency, n8n's own).

It isn't an n8n *verified* node: n8n's verification programme expects an MIT licence and this
package is AGPL-3.0-only, so n8n Cloud doesn't offer it. Its node types are
`@openrows/n8n-nodes-openrows.openRows` and `@openrows/n8n-nodes-openrows.openRowsTrigger`.

From a checkout instead (development):

```sh
npm ci
npm run build -w @openrows/n8n-nodes-openrows
mkdir -p ~/.n8n/custom/node_modules/@openrows
cp -r packages/n8n-nodes-openrows ~/.n8n/custom/node_modules/@openrows/n8n-nodes-openrows
```

## Credentials

**OpenRows API**:

| Field | Value |
| --- | --- |
| Server URL | `https://app.openrows.io`, or your self-hosted server |
| Personal Access Token | `or_pat_…`, from Settings → "Developer: personal access tokens" |

n8n tests the credential with `GET /api/v1/meta/bases`. The token needs these scopes:

| Scope | For |
| --- | --- |
| `schema.bases:read` | the base, table and field pickers; search without picked fields |
| `data.records:read` | get, get many, search |
| `data.records:write` | create, update, create or update, delete |
| `webhook:manage` | the trigger |

Limit the token to the workspaces or bases the workflows need. n8n stores it encrypted and sends
it only as the `Authorization: Bearer` header of the nodes' requests; errors never include it.

## OpenRows node

Pick a base and a table from the lists (or enter their ids; a table also by name).

| Operation | What it sends |
| --- | --- |
| Get | `GET /api/v1/{base}/{table}/{recordId}` |
| Get Many | `POST …/listRecords`, paged by 100 up to the limit (or all): filter by formula, output fields, sort, view |
| Search | Get Many with `SEARCH("text", {Field})` over the picked fields, or every text field (up to 20), and the filter if any |
| Create | `POST /api/v1/{base}/{table}` |
| Update | `PATCH /api/v1/{base}/{table}` with the record id |
| Create or Update | `PATCH` with `performUpsert.fieldsToMergeOn`: 1 to 3 "fields to match on" |
| Delete | `DELETE /api/v1/{base}/{table}?records[]=…` (to the base's trash) |

- **Fields** for writes come from the table's schema (computed fields are left out): set them one
  by one, or map each item's JSON automatically (keys that aren't writable fields, like `id` and
  `createdTime` from an earlier OpenRows node, are dropped). **Typecast** reads text values the
  way the API's `typecast` does (new select options, linked records by name).
- Writes go **10 records per request** (the API's batch size), in order; consecutive items for
  the same table share a request. Reads run once per input item.
- Each record comes out as one item: its cells by field name, then `id` and `createdTime`.
- A `429` is retried after its `Retry-After` (up to 3 times, waits up to 30 s); other errors show
  the API's message, its code and the request id. With **Continue On Fail**, a refused batch fails
  each of its items.

## OpenRows Trigger

Pick a base, the events (`record.created`, `record.updated`, `record.deleted`, `form.submitted`,
`field.*`, `table.*`) and optionally some tables (none: every table, including new ones).

- **Activating** the workflow (or listening for a test event) creates a webhook on the base
  pointing at n8n's webhook URL, described as `n8n: <workflow name>`; its signing secret is kept in
  the workflow's static data. **Deactivating** deletes it. If the webhook was deleted, moved, or
  turned off by OpenRows (failures, lost access), the next activation registers a new one.
- Every delivery's `X-OpenRows-Signature` is checked against the raw body with the secret
  (HMAC-SHA256, constant time) and its timestamp must be within 5 minutes; anything else is
  answered `401` and starts nothing. A `ping` (the webhook's "Send test") is answered without
  starting the workflow.
- **Simplify** (on by default) outputs `event`, `eventId`, `timestamp`, `baseId`, `baseName`,
  `tableId`, `tableName`, `recordId`, `fields` (after the change, by field name),
  `previousFields`, `changedFields` (updates), `field` (field events), `actor` and `webhookId`.
  Off: the payload as delivered, cells by field id.
- Deliveries are retried by OpenRows and may arrive out of order: use `eventId` to skip repeats.

OpenRows delivers only to public `https` URLs on port 443, unless a self-hosted server allows
more (`OUTBOUND_HTTP_*`, see the deployment docs). n8n's webhook URL (`WEBHOOK_URL`) must be one
of those. A base has at most 10 webhooks.

## Development

```sh
npm run build -w @openrows/n8n-nodes-openrows   # tsc to dist/ (CommonJS, as n8n loads it) + icons
npx vitest run --project n8n-nodes-openrows
```

The unit tests run every operation and the trigger against a fake of the API on a local port
(`test/fake-api.ts`), with n8n's function contexts mocked the way n8n's own node tests do
(`src/testing/harness.ts`; n8n's NodeTestHarness isn't published). The integration test against
the real server is `packages/server/test/integration/n8n.test.ts` (`npm run test:integration`).

## License

AGPL-3.0-only, like the rest of the OpenRows core.

## Releasing

Pushing an `n8n-v<version>` tag (the version in `package.json`) runs
`.github/workflows/release-packages.yml`, which builds, tests, checks the tarball and publishes
with provenance. Nothing is published from a local machine.
