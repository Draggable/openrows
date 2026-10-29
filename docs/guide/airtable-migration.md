# Moving from Airtable

Bring your Airtable bases into OpenRows with the built-in importer, see what changes on the way, and point code written for Airtable's API at OpenRows.

## Before you start

- You import into a workspace where you are an **owner** or **creator**. Each Airtable base becomes a new base there; nothing is written to your existing bases.
- Invite your team first (see [Sharing and permissions](sharing.md)). Airtable's collaborator cells are matched to workspace members by email; people who aren't members yet are left out of those cells.
- An import copies a base once. It doesn't keep the two in sync: importing the same base again creates another new base.

## Import your bases

### Create an Airtable token

At [airtable.com/create/tokens](https://airtable.com/create/tokens), create a personal access token with the scopes `data.records:read` and `schema.bases:read`, and give it access to the bases you want to move. It starts with `pat`.

OpenRows uses the token only for the import. It is kept encrypted while the import runs and deleted when it ends, or 24 hours after the start at the latest (an import still running then fails). You can revoke it at Airtable once you're done.

### Pick bases and start

1. On **Home**, choose **Import from Airtable**.
2. Paste the token and choose **Find bases**. OpenRows lists the bases the token can read.
3. Tick up to 10 bases and choose **Import**. Each starts at once, in a new base named after the Airtable one.

If Airtable refuses the token, or the token can't read a base you picked, the dialog says so before anything is created.

### Progress and cancelling

The dialog's **Your imports** list shows each import with a progress bar, the tables, records, files and linked records so far, and an estimate of the time left. An import goes through three steps: "Creating tables, fields and views", "Importing records" and "Linking records". It keeps running if you close the dialog or the tab, and the browser you started it from shows a notice with **Open base** when it ends. Finished imports stay in the list for 7 days.

Airtable allows 5 requests a second, and OpenRows reads 100 records per request, so large bases take a while.

**Cancel** stops a running import. The new base keeps what was imported so far. A cancelled or failed import leaves its half-filled base in place: delete it from the base menu if you don't want it.

### The import report

When an import ends, a summary line says what needed attention, and **Import report** lists it field by field:

| Section | What it lists |
| --- | --- |
| Left out | Fields that weren't imported, with the reason |
| Formulas kept as text | Formulas that didn't translate, with the formula and the reason |
| Changed type | Fields imported as another type, and how |
| Files not copied | Attachments that couldn't be copied |
| Views not imported | Views of types the importer doesn't bring over |

It also counts links that were skipped and names tables cut short at 100,000 records.

## What maps to what

Field names, descriptions and options (number precision, currency, date and time formats, time zones, rating and checkbox icons, select choices and their colours) come along where OpenRows has them. See [Fields](fields.md) for each type.

| Airtable field | OpenRows field |
| --- | --- |
| Single line text, Email, URL | Single line text, Email, URL |
| Phone number | Phone number |
| Long text | Long text |
| Long text with rich text | Long text with rich text on |
| Number, Percent | Number, Percent |
| Currency | Currency. A symbol OpenRows can't match to a currency code becomes USD (reported) |
| Duration | Duration |
| Rating | Rating (at most 10; the star icon when Airtable's isn't available) |
| Checkbox | Checkbox |
| Date, Date with time | Date, Date and time, with Airtable's time zone; a field shown in each collaborator's own time zone becomes UTC |
| Single select, Multiple select | Single select, Multiple select, with choices and colours |
| User (one or several) | User (one or several), matched by email to workspace members |
| Barcode | Barcode |
| Attachment | Attachment, with the files copied |
| Link to another record | Link to another record, with its inverse field |
| Lookup | Lookup |
| Count | Count |
| Rollup | Rollup when OpenRows can tell its function, otherwise see below |
| Formula | Formula when it translates, otherwise see "Formulas" |

### Fields kept with Airtable's values

Some fields Airtable computes would get different values if OpenRows computed them (the import's time, new numbers). They become plain fields holding Airtable's values, listed under "Changed type":

| Airtable field | Becomes |
| --- | --- |
| Created time, Last modified time | Date or Date and time, with Airtable's values |
| Created by, Last modified by | User, with Airtable's people |
| Autonumber | Number, with Airtable's numbers |
| Button | URL, with each button's link (the label is lost) |
| AI text | Long text, with the generated values |
| Rollup whose function Airtable's API doesn't reveal | A plain field of the rollup's result type, with Airtable's values |
| Lookup, rollup or count that reads a field that wasn't imported as it is | A plain field with Airtable's values |

These values don't update any more. If you want OpenRows to keep them current, add a field of the matching type (for example Created time or Autonumber); for imported records it counts from the import.

### Fields left out

- Fields synced from another Airtable base or source: they belong to Airtable's sync.
- Field types OpenRows doesn't have yet.
- Fields beyond 500 in one table.

The primary field always comes along. When its type can't be a primary field here (a formula, a link, a lookup and the like), it becomes single line text with Airtable's values.

## Links, lookups, rollups and counts

An Airtable link and its inverse become one OpenRows link field and its inverse, with Airtable's names and the "allow linking to multiple records" setting. Links in OpenRows always go both ways, so a one-way Airtable link gets an inverse field in the other table (reported). A link from a table to itself has no inverse field here. A cell keeps at most 1,000 links, and links to records that weren't imported are skipped (counted in the report).

Lookups, rollups and counts become live OpenRows fields once the fields they read exist. Airtable's API reveals a rollup's function only for simple ones such as `SUM(values)` or `ARRAYJOIN(values, ", ")`; OpenRows rollups support SUM, AVG, MIN, MAX, COUNT, COUNTA, COUNTALL, AND, OR, XOR, ARRAYJOIN, ARRAYUNIQUE, ARRAYCOMPACT and CONCATENATE. Any other rollup keeps Airtable's values in a plain field.

## Attachments

Files are copied from Airtable while their records are imported, up to 100 MB per file and 100 files per cell, with thumbnails for images. A file whose type doesn't match its contents is stored as a download, not shown as an image. Files that fail (too large, gone at Airtable, no storage left on the workspace's plan) are listed under "Files not copied"; the record is imported without them, so upload them again by hand.

## Views

- **Grid views** come over with their visible fields in Airtable's order. The first one replaces the table's default "Grid view".
- **Kanban views** come over stacked by the table's first single select field (or, without one, its first one-person User field), which may not be the field Airtable stacked by.
- Calendar, gallery, timeline, list, form and other views aren't imported; the report names them. Create them again (see [Views](views.md) and [Forms](forms.md)).

Airtable's API doesn't share views' filters, sorts, groups, row colours or manual record order, so set those again. Records arrive in the order Airtable's API lists them.

## Formulas

OpenRows formulas use Airtable's syntax and function names, so most formulas translate as they are: field references are rewritten to the imported fields, and the formula is checked like one you type (see [Fields](fields.md)). A formula is kept as text instead when:

- it uses a function OpenRows doesn't have;
- OpenRows' stricter type check refuses it, for example text in arithmetic, dates with `+` or `-`, or lists in comparisons;
- it reads a field that was left out or a formula that was kept as text;
- formulas read each other in a loop;
- it is the table's primary field.

Such a field is single line text holding Airtable's results, with `Airtable formula: …` (by field names) in its description, so you can fix it and convert the field to a formula.

Formulas that translate can still behave differently:

- `REGEX_MATCH`, `REGEX_EXTRACT` and `REGEX_REPLACE` use RE2 syntax: no backreferences or lookaround, and patterns of at most 1,000 characters.
- `LAST_MODIFIED_TIME()` accepts field arguments but returns when the record last changed.
- `CREATED_TIME()` and `LAST_MODIFIED_TIME()` count from the import for imported records, and `RECORD_ID()` returns the OpenRows record id.
- Dates are in UTC unless the formula uses `SET_TIMEZONE`, as in Airtable. `DATETIME_FORMAT` and `DATETIME_PARSE` take the same format tokens.
- A formula gets 100,000 steps and 100 ms per record, results are capped (text at 100,000 characters, lists at 10,000 items, numbers at plus or minus 10 to the 15th), and a formula that fails shows `#ERROR!`.

## What isn't imported

- Comments and record revision history.
- Interfaces, extensions and Airtable's sync.
- Automations: rebuild them in OpenRows (see [Automations](automations.md)).
- Collaborators, roles and permissions on the base, tables or fields: set them up again (see [Sharing and permissions](sharing.md)).
- Share links and forms (see [Sharing](sharing.md) and [Forms](forms.md)).
- View settings beyond the ones above.
- More than 100,000 records per table: the rest of a larger table is cut off and the report names it.

If your workspace's plan limits records or file storage, an import stops at the record limit and keeps what it imported, and files past the storage limit aren't copied.

## The REST API

OpenRows' REST API follows the shape of Airtable's Web API, so most scripts and integrations need only a new address, a new token and new ids. The full reference is in [REST API v1](../api/v1.md).

- **Address:** `https://api.airtable.com/v0/…` becomes `https://<your OpenRows address>/api/v1/…` (on the hosted service, `https://app.openrows.io/api/v1/…`).
- **Token:** create a personal access token in **Settings** → "Developer: personal access tokens" and send it as `Authorization: Bearer or_pat_…`. The scopes have Airtable's names: `schema.bases:read`, `schema.bases:write`, `data.records:read`, `data.records:write`, `data.recordComments:read`, `data.recordComments:write`, `user.email:read`.
- **Ids:** bases, tables, fields, views and records have UUIDs without Airtable's `app`, `tbl`, `fld` or `rec` prefixes, and an import gives everything new ids. Replace Airtable ids in your code, or name tables and fields instead.
- **Airtable's JavaScript client** works when you point it at OpenRows:

```js
import Airtable from 'airtable';

const base = new Airtable({
  apiKey: process.env.OPENROWS_TOKEN,
  endpointUrl: 'https://app.openrows.io/api',
  apiVersion: '1.0.0', // the client builds /v<major>/ URLs
}).base('<base id>');

const done = await base('Projects').select({ filterByFormula: "{Status} = 'Done'" }).all();
```

Differences to know:

- Tables are named by id or name, only inside the base in the path. Cells are keyed by field name, or by field id with `returnFieldsByFieldId`.
- `filterByFormula` supports a subset: `AND`, `OR`, `NOT`, a field compared with a value, `BLANK()`, `TODAY()`, `FIND` and `SEARCH`, `IS_BEFORE`, `IS_AFTER`, `IS_SAME` and `RECORD_ID()`. Anything else answers 422 `INVALID_FILTER_BY_FORMULA`.
- Error bodies keep Airtable's shape and error types, but statuses are OpenRows': 404 for anything outside your access, 422 for invalid input.
- Rate limits match Airtable's: 5 requests a second per base (burst 10) and 50 a second per token (burst 100). Pages hold up to 100 records and writes take up to 10 records.
- Deleted records go to the base's trash.
- Attachments can't be added from a URL through the API yet: upload the file first.
- Webhooks have their own format: see [Webhooks](../api/webhooks.md).

For new code there is also a typed JavaScript SDK, `@openrows/sdk`, and AI agents can use the API through the MCP server (see [MCP](../api/mcp.md)).

## CSV import instead

If you only need a table's data, or can't create an Airtable token, download a CSV from an Airtable view and import it:

- On **Home**, **Import a file** makes a new base from a CSV of up to 50 MB, with field types suggested from the values.
- In a table, the view toolbar's **More view actions** (…) → **Import CSV…** adds rows to an existing table: you choose which field each column goes to. Up to 50 MB and 250,000 rows.

A CSV carries one table at a time and only cell text: no formulas, links between tables, attachment files or views. See [CSV import](bases-and-tables.md#csv-import).

## After the import: a checklist

1. Read the import report of each base.
2. Check the fields listed under "Changed type", and add live Created time, Autonumber or similar fields where you need them.
3. Fix the formulas kept as text: the original is in each field's description.
4. Recreate rollups and lookups that kept Airtable's values.
5. Set filters, sorts, groups, row colours and kanban stack fields again, and create the calendar, gallery, timeline, list and form views you had.
6. Re-upload the files listed under "Files not copied", and import the rest of any table cut short at 100,000 records.
7. Fill in user cells for people who weren't workspace members during the import.
8. Share the base and set table and field permissions (see [Sharing and permissions](sharing.md)).
9. Rebuild automations, forms and share links.
10. Move integrations to the OpenRows API: new address, token and ids.
11. Delete half-filled bases from cancelled or failed imports, and revoke the Airtable token.

Airtable is a trademark of Formagrid, Inc. OpenRows isn't affiliated with or endorsed by Airtable.
