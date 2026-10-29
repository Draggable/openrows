# @openrows/sdk

A typed JavaScript client for the [OpenRows](https://app.openrows.io) REST API v1. ESM and
CommonJS, Node 20+ and browsers, no dependencies beyond `fetch`. Its types are generated from the
API's own contracts, so they say what the server checks.

```sh
npm install @openrows/sdk
```

## Quick start

Create a personal access token in OpenRows (Settings → "Developer: personal access tokens") with
the scopes you need, then:

```ts
import { OpenRows } from '@openrows/sdk';

const openrows = new OpenRows({
  apiKey: process.env.OPENROWS_TOKEN, // or_pat_…
  baseUrl: 'https://app.openrows.io', // the default; your own server's origin when self-hosted
});

const bases = await openrows.bases.list();
const tables = await openrows.tables(bases[0].id).list();
```

`require('@openrows/sdk')` works too.

## Records

A table is named by id or name. Cells are keyed by field name (or id, with
`returnFieldsByFieldId`). Give the table your fields' types to have them checked:

```ts
type Task = { Name: string; Status: string; Points: number };
const tasks = openrows.table<Task>(baseId, 'Tasks');

// Every record, page by page (100 at most per request).
const done = await tasks
  .select({
    view: 'Grid view',
    filterByFormula: "{Status} = 'Done'",
    sort: [{ field: 'Points', direction: 'desc' }],
    fields: ['Name', 'Points'],
  })
  .all();

// One page at a time; answer `false` to stop.
await tasks.select({ pageSize: 50 }).eachPage((records) => {
  for (const r of records) console.log(r.id, r.fields.Name);
});

// Or iterate, with one page in memory at a time.
for await (const record of tasks.select()) console.log(record.fields.Name);

const first = await tasks.select({ maxRecords: 1 }).firstPage();
const one = await tasks.find(recordId);
```

Writes take any number of records and send them 10 per request, in order. A failed request
throws; the batches before it are already saved.

```ts
const created = await tasks.create([{ fields: { Name: 'Write docs' } }, { fields: { Name: 'Ship' } }]);
const single = await tasks.create({ Name: 'Review', Status: 'Todo' });

// typecast: new select options are added, linked records found by name.
await tasks.create({ Name: 'Triage', Status: 'Blocked' }, { typecast: true });

await tasks.update(single.id, { Status: 'Done' }); // only the fields given change
await tasks.update([{ id: single.id, fields: { Points: 3 } }]);
await tasks.replace(single.id, { Name: 'Review' }); // fields left out are cleared
await tasks.replace([{ id: single.id, fields: { Name: 'Review' } }]);

// Update records matching on up to 3 fields, create the others.
const { createdRecords, updatedRecords } = await tasks.upsert(
  [{ fields: { Name: 'Ship', Points: 5 } }],
  { fieldsToMergeOn: ['Name'] }
);

await tasks.destroy(single.id); // to the trash
await tasks.destroy(created.map((r) => r.id));
```

## Comments

```ts
const comments = tasks.comments(recordId);
await comments.create('Looks good to me');
const page = await comments.page({ pageSize: 20 }); // newest first, with `offset`
const all = await comments.all();
```

## Schema

```ts
const table = await openrows.tables(baseId).create({
  name: 'Projects',
  fields: [
    { name: 'Name', type: 'singleLineText' }, // the first field is the primary field
    { name: 'Stage', type: 'singleSelect', options: { choices: [{ name: 'Idea' }] } },
  ],
});
const projects = openrows.table(baseId, table.id);
const field = await projects.fields.create({ name: 'Budget', type: 'number' });
await projects.fields.update(field.id, { description: 'In euros' });
```

## Webhooks

Needs the `webhook:manage` scope and the creator role on the base.

```ts
const hooks = openrows.webhooks(baseId);
const hook = await hooks.create({
  url: 'https://example.com/hooks/openrows',
  events: ['record.created', 'record.updated'],
});
console.log(hook.secret); // the signing secret, shown only this once

await hooks.list();
await hooks.update(hook.id, { enabled: false });
const rotated = await hooks.update(hook.id, { rotateSecret: true });
await hooks.ping(hook.id); // a signed test event, answered with the attempt
await hooks.deliveries(hook.id, { limit: 20 });
await hooks.redeliver(hook.id, deliveryId); // queues a logged event again, same event id
await hooks.delete(hook.id);
```

## Automations

The automations built in the app: the creator role on the base, with `automations:read` (list,
get, runs), `automations:manage` (on and off) and `automations:run` (trigger).

```ts
const automations = openrows.automations(baseId);
const [first] = await automations.list();
await automations.setEnabled(first.id, true); // it then runs as you
// A webhook-received automation, with any JSON body; a button-clicked one with { recordId }.
const { triggerId } = await automations.trigger(first.id, { body: { orderId: 42 } });
await automations.runs(first.id, { limit: 10, status: 'failed' });
```

## Errors

Every refusal throws an `OpenRowsError`:

```ts
import { isOpenRowsError } from '@openrows/sdk';

try {
  await tasks.select({ filterByFormula: 'LOWER({Name})' }).all();
} catch (error) {
  if (isOpenRowsError(error)) {
    error.status; // 422
    error.type; // 'INVALID_FILTER_BY_FORMULA' (Airtable's error type where one fits)
    error.code; // OpenRows' stable code
    error.requestId; // quote it when reporting a problem
    error.errors; // what failed validation
  }
}
```

## Rate limits

A request answered `429` is retried after its `Retry-After` (3 times by default). A wait longer
than `maxRetryDelay` throws at once, with `error.retryAfter` (seconds) and `error.limit` (`base`,
`token` or `user`).

## Options

| Option | Default | |
| --- | --- | --- |
| `apiKey` | | A personal access token. Leave it out in a browser signed in to the same app |
| `baseUrl` | `https://app.openrows.io` | The app's origin (`…/api` and `…/api/v1` work too) |
| `maxRetries` | `3` | Retries of a 429 |
| `maxRetryDelay` | `60000` | The longest `Retry-After` to wait, in ms |
| `timeout` | `60000` | Per request, in ms (`0`: none) |
| `fetch` | `globalThis.fetch` | Your own `fetch` |
| `headers` | | Extra headers for every request |

Keep tokens out of code that runs in someone else's browser: a token can do whatever its scopes
and its owner allow.

## Reference

The full reference is at [/docs/api/sdk](https://app.openrows.io/docs/api/sdk), and the HTTP API's
at [/docs/api](https://app.openrows.io/docs/api).

## License

AGPL-3.0-only, like the rest of the OpenRows core.

## Releasing

Pushing an `sdk-v<version>` tag (the version in `package.json`) runs
`.github/workflows/release-packages.yml`, which builds, tests, checks the tarball and publishes
with provenance. Nothing is published from a local machine.
