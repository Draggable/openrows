# Bases, tables and records

How to organize data in bases and tables, edit records in the grid, comment, follow a record's history, import, export, restore and snapshot.

## Bases

A base is a set of related tables that can link to each other, much like an Airtable base. Bases live in a workspace, and everyone in the workspace gets their workspace role in every base. You can also invite people to a single base; see [Sharing and permissions](sharing.md).

To create a base, see [Getting started](getting-started.md#create-a-base). Click the base name at the top of the sidebar for the base menu:

| Item | What it does | Who sees it |
| --- | --- | --- |
| **All bases** | Back to Home | Everyone |
| **Trash** | Deleted tables, fields, views and records | Editors and up |
| **Duplicate base** | Copy the base, with or without its records; see [Duplicate a base](#duplicate-a-base) | Creators and owners |
| **Snapshots** | Point-in-time copies of the base | Creators and owners |
| **Webhooks** | Send changes to other services; see [Webhooks](../api/webhooks.md) | Creators and owners |
| **Save as template** | Download the base as a template file; see [Templates](#templates) | Creators and owners |
| **Export base (ZIP)** | Download everything you can read | Everyone |
| **Delete base** | Move the base to the workspace's trash | Creators and owners |

### Duplicate a base

**Duplicate base** in the base menu makes a copy that works on its own: editing one never changes the other. Pick the copy's name, the workspace it goes to (any workspace where you're a creator or owner) and whether to **Copy records, links and attachments**; without them you get the structure only, like a template. The copy is made in the background and opens when it's ready.

The copy has every table, field (links, lookups, rollups and formulas point at the copy's own tables and fields), view (filters, sorts, groups, colours, form settings) and automation. Automations start turned off; secret headers and Slack webhook URLs aren't copied, so enter them again before you turn one on. Share links, webhooks, collaborators, comments, revision history, snapshots and other people's personal views stay with the original. The copy's records and attachments count against the plan of the workspace you copy to.

### Templates

**Start from a template** on Home (or in the **New base** dialog) opens the template gallery: a product roadmap, a sales CRM, a project tracker, a content calendar, a bug tracker, event planning, inventory, a hiring pipeline, OKRs and customer feedback. Pick a category, open a template to preview each of its tables with their fields and first records, then **Use template**: you get a new base with the tables, fields, views and sample records, in the workspace you're on (where you're a creator or owner). Edit or delete the sample records as you like. A template's automations come turned off. The same templates are listed at [openrows.io/templates](https://openrows.io/templates).

**Save as template** in the base menu downloads the base as a template file (`.openrows-template.json`): its tables, fields, the views everyone sees, automations without their secrets, and up to 1,000 records per table (5,000 in all). Files, collaborator cells and computed values aren't in it; computed fields are worked out again when the template is used. On your own server, add the file to the built-in templates (`packages/shared/src/templates/`) to offer it in the gallery.

### The AI assistant

When your workspace has an AI provider (Settings → AI, or the server's own), creators and owners see **Assistant** in a base's top bar. Describe what you want, like "add a Total formula to Orders and a kanban view by status", and **Draft plan**: the assistant proposes new tables, fields (formulas included), views and automations, and lists each one with its fields and settings. Every formula it suggests is checked; one that doesn't work is shown with the problem and left unticked. Untick anything you don't want and click **Apply**: nothing changes in the base until then, and the changes are made with your own permissions, all together or not at all. Automations it creates start turned off.

The assistant sees the names and types of the base's tables and fields, not your records. Tick **Include a few records from each table** to send up to three records per table along with the request, which helps it pick formats and options.

On Home, **Describe it** does the same for a new base: say what you want to track, check the plan and the base's name, then **Create base**.

## Tables

A table is a list of records with the same fields, like a sheet in a spreadsheet. The sidebar lists the base's tables. Creators and owners can:

- **Add table**: adds "Table 2" (and so on) with the fields Name, Notes and Status (Todo, In progress, Done) and a "Grid view".
- Rename a table: double-click it, or choose **Rename** in its "..." menu.
- Reorder tables with **Move up** and **Move down**.
- Limit who can add, edit or delete records with **Edit permissions**; see [Sharing and permissions](sharing.md).
- **Delete table**: moves it to the base's trash. A base keeps at least one table.

Every table has a primary field, the first column, which names each record in links, the trash and notifications. Fields are covered in [Fields](fields.md), views in [Views](views.md).

## Records

A record is one row of a table. Editors and up add, edit and delete records; commenters and read-only members can read them, and commenters can also comment.

### Add and delete records

- Click **+** (Add record) below the last row of a grid, or just paste rows past the end.
- Right-click a selection for **Copy**, **Fill down**, **Clear cells**, **Duplicate** and **Delete** (with the number of records selected).
- Deleted records go to the trash. A message with **Undo** appears right after.

The bar at the bottom of the grid shows how many records the view holds.

### Edit in the grid

Select a cell and start typing to replace its value, or press **Enter** or **F2** to edit it. Double-clicking a cell also opens its editor.

| Keys | In the grid |
| --- | --- |
| Arrow keys | Move one cell |
| Ctrl/Cmd + arrow | Move to the first or last row or column |
| Tab, Shift+Tab | Next or previous cell, wrapping to the next row |
| Home, End | First or last column (with Ctrl/Cmd: first or last record too) |
| Page Up, Page Down | Move by a screen |
| Shift + arrow, Shift + click | Select a range |
| Enter, F2 | Edit the cell |
| Enter (while editing) | Save |
| Tab (while editing) | Save and move to the next cell |
| Esc | Cancel the edit, or shrink a range to one cell |
| Delete, Backspace | Clear the selected cells |
| Space | Expand the record (on a checkbox: toggle it; Shift+Space expands) |
| Ctrl/Cmd D | Fill down |
| Ctrl/Cmd F | Find in the view |

In a long text cell, Enter adds a line; press **Ctrl Enter** (or Tab) to save. Click a row number to select the whole row, and Shift + click to select several. You can drop files from your computer onto an attachment cell.

Computed fields (formulas, lookups, rollups, counts and the like) are read-only. A cell that the server refuses to save shows an error in place.

### Copy, paste and fill

- **Copy** (Ctrl/Cmd C) puts the selected cells on the clipboard as text that spreadsheets, Airtable and OpenRows understand. Ctrl/Cmd X cuts.
- **Paste** (Ctrl/Cmd V) starts at the top-left cell of your selection. Each pasted value is converted to the target field's type, and values that don't fit are skipped. Read-only and computed columns are skipped too.
- If you paste one cell (or a block) into a larger selection that is a whole multiple of it, the paste repeats to fill the selection.
- If the paste runs past the last record, OpenRows asks before adding the new records (**Add records**).
- Creators and owners can paste options that a single or multiple select field doesn't have yet; they are added to the field.
- **Fill down** (Ctrl/Cmd D, the context menu or the fill handle) copies the top row of the selection into the rows below it. Values are copied, not continued as a series.

### Undo and redo

Press **Ctrl/Cmd Z** to undo and **Ctrl/Cmd Shift Z** or **Ctrl/Cmd Y** to redo. Undo covers cell edits, pastes, fills, clears, new records, duplicates and deletions, for your last 100 actions.

## Expand a record

Press **Space** on a row, or hover the row number and click the expand icon, to open the record with every field. The record's address goes into the page URL, so you can share it.

- **Previous record** and **Next record** buttons, or the **Up**/**Down** arrow keys (also **K**/**J**), move through the view's records.
- **Copy record link** copies a link that opens this record.
- **Show as a side panel** keeps the record beside the grid while you work; **Show as a modal** switches back.
- **More record actions** has **Copy record link** and **Delete record**.
- Fields hidden in the current view appear under **Hidden in this view**.

The record has three tabs, **Fields**, **Comments** and **Activity**. On a wide screen, comments and activity sit beside the fields.

## Comments

Commenters and up can comment on a record; read-only members can read the comments.

- Write in the box at the bottom and press **Ctrl Enter** (Cmd Enter on a Mac) or **Send**. Enter adds a line.
- Type **@** to mention someone. Only people with access to the base are suggested; use the arrow keys and Enter or Tab to pick one. Mentioned people get a notification.
- Comments take basic Markdown formatting, up to 10,000 characters and 50 mentions.
- React with one of six emoji reactions.
- **Comment actions** lets you **Edit comment** (your own) or delete it. You can delete your own comments; creators and owners can delete anyone's.
- Each record shows its newest 50 comments; **Load earlier comments** shows more. A badge on the row number counts a record's comments.

## Activity and revision history

The **Activity** tab lists the record's history, oldest first: who created it, every change to its cells (before and after) and its comments. Submissions through a public form show "Form" as the author. Several edits to the same cells by the same person within a minute are merged into one entry. Fields hidden from you are left out.

- **Restore this value** (next to a changed cell) sets that one field back to the value it had right after the change.
- **Restore record to this point** sets the whole record back to how it was right after that change.

A restore is a normal edit: it shows up in the history, and table and field edit permissions still apply.

On a self-hosted server, history is kept for 365 days unless the server sets another period. On the hosted service, your plan's limits apply (see https://openrows.io/pricing).

## CSV import

You can import a CSV file into a new base from Home (**Import a file**), or into an existing table: in a grid view, open the toolbar's **More view actions** menu and choose **Import CSV…** (editors and up).

1. **Choose a CSV file** of up to 50 MB (at most 250,000 rows and 500 columns). Commas, semicolons, tabs and pipes are detected.
2. Tick or untick **First row is the header**.
3. For each column, choose an existing field under **Import into**, **New field** (with a name and a type; creators and owners), or **Don't import**. A preview shows the first values.
4. Creators and owners can keep **Add missing options to select fields** on, so new select values become options.
5. Choose **Import**. A progress bar follows the import.

Each row becomes a record. Values that can't be read for their field are left empty and counted in the summary. One import runs per table at a time.

## CSV export

In a grid view's **More view actions** menu, choose **Download CSV**. The file holds the view as you see it: its filter, sort and grouping order, its visible fields in column order, and any find term or unsaved toolbar changes. Cells are written as display text, ready for a spreadsheet, and values that start with characters like `=` or `+` are protected so a spreadsheet won't run them as formulas.

## Export a base or your data

**Export base (ZIP)** in the base menu downloads everything you can read in the base:

- `schema.json`: the base, its tables, fields and the views you can see.
- A CSV file per table (re-importable with the CSV import) and a JSON lines file per table with record ids and values.
- The attachments, with a list of them.

Other people's personal views are left out. The export reads the tables one after the other, so for an exact point-in-time copy use a snapshot.

To download all your own data, go to **Settings**, **Your data**, **Export my data**. Its ZIP holds your profile, memberships, the comments you wrote and a base export of every base in the workspaces you own.

Each person can start 10 exports every 10 minutes.

## Trash and restore

Deleting a base, table, field, view or record moves it to the trash for 30 days. Each item shows when it was deleted and how many days are left.

- **Base trash** (base menu, **Trash**): tabs for **Records**, **Fields**, **Views** and **Tables**. On the Records tab, pick the table first.
- **Workspace trash** (**Trash** on Home or in the sidebar): deleted bases, with everything in them. Creators and owners.

Choose **Restore** to put an item back where it was. Who can restore:

| Item | Restore | Delete permanently |
| --- | --- | --- |
| Records | Editors and up | Creators and owners |
| Views | Editors and up | Creators and owners |
| Fields, tables | Creators and owners | Creators and owners |
| Bases | Workspace creators and owners | Workspace creators and owners |

Deleting permanently can't be undone. Other people's personal views stay private in the trash.

## Base snapshots

A snapshot is a point-in-time copy of a whole base: its tables, fields, views, records, links and attachments. Open **Snapshots** in the base menu (creators and owners).

- OpenRows takes an automatic snapshot every day of each base that changed since its last one.
- **Snapshot now** takes a manual one.
- **Restore to new base** creates a copy named "Base name (restored)" in the same workspace. The original base stays as it is.
- Delete a snapshot with its delete button.

Snapshots are kept for 30 days by default. Workspace owners can change this under **Keep for** (1 to 365 days). A base keeps at most 100 snapshots; the oldest automatic ones go first. On the hosted service, your plan's limits apply (see https://openrows.io/pricing).
