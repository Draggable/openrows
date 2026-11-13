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
| Views not imported | Views that couldn't be created, with the reason (a form, or a calendar in a table without a date field) |
| View settings not imported | Each view that was created: the fields chosen for it here and the settings Airtable's API doesn't share |

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
| Created time | Created time, with Airtable's creation times (see below) |
| Created by | Created by, with Airtable's creators matched by email (see below) |
| Attachment | Attachment, with the files copied |
| Link to another record | Link to another record, with its inverse field |
| Lookup | Lookup |
| Count | Count |
| Rollup | Rollup when OpenRows can tell its function, otherwise see below |
| Formula | Formula when it translates, otherwise see "Formulas" |

### Created time and Created by

Created time and Created by fields come over as live OpenRows fields. Every imported record keeps the time Airtable says it was created (also when the table has no Created time field, so `CREATED_TIME()` in formulas reads it too), and, when the table has a Created by field, the person who created it in Airtable, matched by email to workspace members. A creator who isn't a member leaves the cell empty (counted as a skipped cell). Records added in OpenRows afterwards get their own time and creator.

A Created time field that Airtable shows as a date only also shows the time of day here, since an OpenRows Created time field always has one (listed under "Changed type"). As the primary field, which can't be a computed field here, Created time and Created by become a plain Date and time (or Date) and User field with Airtable's values.

### Fields kept with Airtable's values

Some fields Airtable computes would get different values if OpenRows computed them. They become plain fields holding Airtable's values, listed under "Changed type" with the reason:

| Airtable field | Becomes | Why |
| --- | --- | --- |
| Last modified time | Date or Date and time, with Airtable's values | Airtable's can follow only some fields, which its API doesn't always say, and OpenRows' follows every change to a record |
| Last modified by | User, with Airtable's people | As for Last modified time |
| Autonumber | Number, with Airtable's numbers | An OpenRows Autonumber field numbers records itself and can't take Airtable's numbers |
| Button | URL, with each button's link (the label is lost) | |
| AI text | Long text, with the generated values | |
| Rollup whose function OpenRows can't tell | A plain field of the rollup's result type, with Airtable's values | See "Links, lookups, rollups and counts" |
| Lookup, rollup or count that reads a field that wasn't imported as it is | A plain field with Airtable's values | The report names the field it reads |

These values don't update any more. If you want OpenRows to keep them current, add a field of the matching type (for example Last modified time or Autonumber); for imported records it counts from the import.

### Fields left out

- Fields synced from another Airtable base or source: they belong to Airtable's sync.
- Field types OpenRows doesn't have yet.
- Fields beyond 500 in one table.

The primary field always comes along. When its type can't be a primary field here (a formula, a link, a lookup and the like), it becomes single line text with Airtable's values.

## Links, lookups, rollups and counts

An Airtable link and its inverse become one OpenRows link field and its inverse, with Airtable's names and the "allow linking to multiple records" setting. Links in OpenRows always go both ways, so a one-way Airtable link gets an inverse field in the other table (reported). A link from a table to itself has no inverse field here. A cell keeps at most 1,000 links, and links to records that weren't imported are skipped (counted in the report).

Lookups, rollups and counts become live OpenRows fields once the fields they read exist. Airtable's documented API doesn't include a rollup's function. When the base's schema does carry it as a formula over `values`, such as `SUM(values)`, `AVERAGE(values)` or `ARRAYJOIN(values, ", ")` (in any letter case), the rollup is live: OpenRows rollups support SUM, AVG (Airtable's AVERAGE), MIN, MAX, COUNT, COUNTA, COUNTALL, AND, OR, XOR, ARRAYJOIN, ARRAYUNIQUE, ARRAYCOMPACT and CONCATENATE. Any other rollup keeps Airtable's values in a plain field, and the report says why: the API didn't give its function, OpenRows has no rollup function of that name, or its formula is more than one function (such as `SUM(values) / 2`).

## Attachments

Files are copied from Airtable while their records are imported, up to 100 MB per file and 100 files per cell, with thumbnails for images. A file whose type doesn't match its contents is stored as a download, not shown as an image. Files that fail (too large, gone at Airtable, no storage left on the workspace's plan) are listed under "Files not copied"; the record is imported without them, so upload them again by hand.

## Views

Airtable's API describes a view by its name and type, and a grid view also by its visible fields in their order. It doesn't share any other view setting: no filters, sorts, groups, row colours, manual record order or column widths, and not which field a kanban view stacks by, which date fields a calendar or timeline view uses, or a gallery's cover and card fields. So views come over like this:

| Airtable view | In OpenRows |
| --- | --- |
| Grid | Grid, with the visible fields in Airtable's order and the rest hidden. The first one replaces the table's default "Grid view" |
| Kanban | Kanban, stacked by the table's first single select field (or, without one, its first one-person User field). Not imported when the table has neither |
| Calendar | Calendar, with records placed by the table's first Date or Date and time field (or, without one, another date such as Created time). Not imported when the table has no date field |
| Timeline | Timeline, with bars starting on the table's first date field, chosen as for calendars, one day long. Not imported when the table has no date field |
| Gallery | Gallery, with the table's first attachment field as the cover (no cover without one) |
| List | List, without nesting |
| Form | Not imported: the API doesn't share a form's questions, labels or settings. Create it again (see [Forms](forms.md)) |
| Gantt and extensions (Airtable's API calls them "block" views) | Not imported: create a timeline view for a Gantt chart (see [Views](views.md)) |

A field picked here may not be the one Airtable's view used. For each view it creates, the report's "View settings not imported" says which field was picked and which settings were left out, so you can check the view and set the rest again. Records arrive in the order Airtable's API lists them.

## Formulas

OpenRows formulas use Airtable's syntax and function names, so most formulas translate as they are: field references are rewritten to the imported fields, and the formula is checked like one you type (see [Fields](fields.md)). A formula may also read a field that kept Airtable's values (a rollup or count kept as a plain field, Last modified time, Autonumber and the like): it computes from those values. A formula is kept as text instead when:

- it uses a function OpenRows doesn't have (the report names it);
- OpenRows' stricter type check refuses it, for example text in arithmetic, dates with `+` or `-`, or lists in comparisons (the report gives the problem and the part of the formula it's in);
- it reads a field that was left out, a lookup that kept Airtable's values, or a formula that was kept as text (the report names the field);
- formulas read each other in a loop;
- it is the table's primary field.

Such a field is single line text holding Airtable's results, with `Airtable formula: …` (by field names) in its description, so you can fix it and convert the field to a formula.

Formulas that translate can still behave differently:

- `REGEX_MATCH`, `REGEX_EXTRACT` and `REGEX_REPLACE` use RE2 syntax: no backreferences or lookaround, and patterns of at most 1,000 characters.
- `LAST_MODIFIED_TIME()` accepts field arguments but returns when the record last changed.
- `CREATED_TIME()` returns Airtable's creation time for imported records. `LAST_MODIFIED_TIME()` counts from the import, and `RECORD_ID()` returns the OpenRows record id.
- Dates are in UTC unless the formula uses `SET_TIMEZONE`, as in Airtable. `DATETIME_FORMAT` and `DATETIME_PARSE` take the same format tokens.
- A formula gets 100,000 steps and 100 ms per record, results are capped (text at 100,000 characters, lists at 10,000 items, numbers at plus or minus 10 to the 15th), and a formula that fails shows `#ERROR!`.

## What isn't imported

- Comments and record revision history.
- Interfaces, extensions and Airtable's sync.
- Automations: rebuild them in OpenRows (see [Automations](automations.md)).
- Collaborators, roles and permissions on the base, tables or fields: set them up again (see [Sharing and permissions](sharing.md)).
- Share links and form views (see [Sharing](sharing.md) and [Forms](forms.md)).
- View settings Airtable's API doesn't share: filters, sorts, groups, row colours, manual record order, column widths, and the fields kanban, calendar, timeline and gallery views use (see "Views").
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

A CSV carries one table at a time and only cell text: no formulas, links between tables, attachment files or views. See [CSV and Excel import](bases-and-tables.md#csv-and-excel-import).

## After the import: a checklist

1. Read the import report of each base.
2. Check the fields listed under "Changed type", and add live Last modified time, Autonumber or similar fields where you need them.
3. Fix the formulas kept as text: the original is in each field's description.
4. Recreate rollups and lookups that kept Airtable's values.
5. Go through "View settings not imported": check the stack, date and cover fields picked for kanban, calendar, timeline and gallery views, set filters, sorts, groups and row colours again, and create the forms and other views listed under "Views not imported".
6. Re-upload the files listed under "Files not copied", and import the rest of any table cut short at 100,000 records.
7. Fill in user cells for people who weren't workspace members during the import.
8. Share the base and set table and field permissions (see [Sharing and permissions](sharing.md)).
9. Rebuild automations, forms and share links.
10. Move integrations to the OpenRows API: new address, token and ids.
11. Delete half-filled bases from cancelled or failed imports, and revoke the Airtable token.

Airtable is a trademark of Formagrid, Inc. OpenRows isn't affiliated with or endorsed by Airtable.
