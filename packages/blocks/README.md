# @openrows/blocks

The typed SDK for [OpenRows](https://openrows.io) extensions: small apps that sit in a base's
extension panel and read and write its records, follow the selected record, keep their own
settings and update live.

```sh
npm install @openrows/blocks
```

## How an extension runs

An extension is a **manifest** and a **bundle** (HTML, CSS and JavaScript) installed on a base.
OpenRows runs it in a sandboxed frame with an opaque origin: no cookies, no storage, no access to
the app's page, and a Content Security Policy without network access (`connect-src 'none'`). Its
only way to the base is `window.openrows`, answered over `postMessage` by the app as the person
looking at it, so an extension can never do more than that person can, and **only what its
manifest's scopes allow**.

| Scope | Gives |
| --- | --- |
| `records:read` | The base's tables, fields and views; `selectRecords`, `getRecord`, `watchRecords` |
| `records:write` | `createRecords`, `updateRecords`, `deleteRecords` (50 records per call) |
| `cursor:read` | `cursor` and the `cursor` event: the open table and view, the selected record and field |
| `settings:write` | `setSettings`: this installation's settings (any extension reads its own) |
| `embed:frames` | Images from `https:` URLs, and frames of YouTube (no-cookie), Vimeo and Loom players |

A call without its scope is refused with an error. Settings writes also need the person to be an
editor or up (`canEditSettings`).

## The package

A package is one JSON file you upload in the panel's **Add extension** dialog (creators and up;
on app.openrows.io, workspace owners only):

```json
{
  "manifest": {
    "manifestVersion": 1,
    "name": "Record count",
    "description": "How many records the open table has.",
    "version": "1.0.0",
    "scopes": ["records:read", "cursor:read"]
  },
  "bundle": {
    "html": "<main><p id=\"count\">…</p></main>",
    "css": "#count { font-size: 24px; }",
    "js": "/* your bundled script */"
  }
}
```

The bundle's HTML goes into the frame's `<body>`; `<script>` elements and inline event handlers
in it never run. The JavaScript runs once, after the HTML is in place. Bundle it (esbuild, Vite,
Rollup) into one script: there is no module loading and no network. Up to 1 MB in all.

The frame has the app's colours as CSS variables (`--or-bg`, `--or-surface`, `--or-text`,
`--or-text-2`, `--or-border`, `--or-accent`, `--or-accent-text`, `--or-danger`), switched by
`data-theme="light|dark"` on `<html>`.

## The API

```ts
import { initializeBlock } from '@openrows/blocks';

const block = await initializeBlock();
const count = document.getElementById('count')!;

async function render() {
  const tableId = block.cursor?.tableId;
  if (!tableId) return;
  const records = await block.selectRecords(tableId, { fields: [] });
  count.textContent = `${records.length} records in ${block.getTable(tableId).name}`;
}

block.on('cursor', render);
let stop = () => {};
block.on('cursor', (c) => {
  stop();
  if (c.tableId) stop = block.watchRecords(c.tableId, render);
});
render();
```

| Member | |
| --- | --- |
| `installation`, `scopes`, `hasScope(scope)` | Who this is and what it may do |
| `base`, `getTable(ref)`, `getTableIfExists(ref)` | Tables, fields and views (`ref`: id, name or `{ id }`) |
| `cursor` | `{ tableId, viewId, recordId, fieldId }` or null |
| `settings`, `canEditSettings`, `setSettings(obj)` | The installation's JSON settings (64 KB) |
| `theme` | `'light'` or `'dark'` |
| `on(event, cb)` | `cursor`, `settings`, `theme`, `base`; answers the unsubscribe |
| `selectRecords(table, { view, fields, sorts, recordIds, limit })` | Up to 5,000 records |
| `getRecord(table, id)` | One record, or null |
| `createRecords`, `updateRecords`, `deleteRecords` | 50 per call; cells by field id or name |
| `watchRecords(table, cb)` | Calls back after the table's records change |
| `openUrl(url)` | Opens an http(s) link in a new tab, after a click |

Records are `{ id, name, createdTime, cells, strings }`: `cells` holds values by field id,
`strings` their display text. Calls are rate-limited (20 a second).

`manifestProblems(manifest)` checks a manifest the way OpenRows will before you upload it.

## Built-in examples

OpenRows ships three extensions on this same API (`packages/shared/src/extensions/samples.ts` in
the repository): **Chart**, **Print view** and **URL preview**.

## Licence

AGPL-3.0-only.
