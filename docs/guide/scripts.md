# Scripts

Scripts are small JavaScript programs that work on a base: clean up duplicates, change many records at once or build a report. They run in your browser, in a sandbox, with your own permissions: a script can only read and change what you could read and change by hand.

Open a base and click **Scripts** in the top bar. Editors, creators and owners see it; creators and owners write and change scripts, editors run them.

## Write a script

Click **+** next to **Scripts**, or pick a tile under **New script**: a blank script or one of the examples (**Remove duplicates**, **Find and replace**, **Summary report**). Each example asks for its table and fields, so it works on any base.

The editor completes the script API as you type: type `base.`, `input.` or `output.`, or `getTable('` for the base's table names. Click **Save** (or press Ctrl/⌘ S) to keep your changes. **Run** (Ctrl/⌘ Enter) runs what is in the editor, saved or not.

```js
const table = base.getTable('Tasks');
const query = await table.selectRecordsAsync({ fields: ['Name', 'Status'] });
const open = query.records.filter((r) => r.getCellValueAsString('Status') !== 'Done');
output.markdown(`**${open.length}** open tasks`);
output.table(open.map((r) => ({ Task: r.name, Status: r.getCellValueAsString('Status') })));
```

## The API

The API follows Airtable's scripting extension, so most Airtable scripts port with small changes.

- `base`: `name`, `tables`, `getTable(nameOrId)`.
- A table: `name`, `fields`, `views`, `primaryField`, `getField(nameOrId)`, `getView(nameOrId)`, `selectRecordsAsync({ fields, sorts, recordIds })`, `selectRecordAsync(id)`, `createRecordAsync(fields)`, `createRecordsAsync([{ fields }])`, `updateRecordAsync(record, fields)`, `updateRecordsAsync([{ id, fields }])`, `deleteRecordAsync(record)`, `deleteRecordsAsync(records)`.
- A view: `selectRecordsAsync()` gives the view's records in its order, with its filters.
- A record: `id`, `name` (the primary field's text), `getCellValue(field)`, `getCellValueAsString(field)`.
- `input`: `textAsync(label)`, `buttonsAsync(label, options)`, `tableAsync(label)`, `viewAsync(label, table)`, `fieldAsync(label, table)`, `recordAsync(label, tableOrViewOrQuery)`. The question shows in the output panel and the script waits for your answer.
- `output`: `text(value)`, `markdown(source)`, `table(rows)`, `inspect(value)`, `clear()`.
- `session.currentUser`, and `console.log` for the output panel.

Fields are named by name or id. Cell values are OpenRows' own: a single select's value is its option's id, for example, so use `getCellValueAsString` for display text. Scripts are JavaScript; TypeScript type annotations aren't supported yet.

## Safety and limits

A script runs in a sandboxed frame with no access to the app, your session, cookies or storage, and no network: `fetch` and `remoteFetchAsync` aren't available. Everything it does to the base goes through the same API as the app, as you, so table and field edit permissions and plan limits apply. Click **Stop** to end a run at any time.

One run may make up to 2,000 calls (20 per second; faster scripts wait), read 50,000 records, change 10,000 and show 1,000 outputs. Create, update and delete take at most 50 records per call, as in Airtable. A run stops after 15 minutes.
