# Synced tables

A synced table copies its records from somewhere else and keeps them up to date: another table or view (in this base, another base, or another workspace you belong to), a CSV file at a URL, or a Postgres table or query. A synced table starts with one source and can sync from several. A sync goes one way by default: changes in a source reach the synced table, never the other way round. A table or view source can also [sync both ways](#sync-both-ways), so that edits made in the synced table go back to it.

## Add a synced table

In a base's sidebar, click **Sync data** and pick the source:

- **A table or view**: pick the base, the table and, optionally, a view (only its records then, as its filter shows them). Choose the fields to copy; the primary field always comes along. Records are matched by the source record, or by a field you pick as the key.
- **A CSV file at a URL**: paste the URL and click **Preview**. The first row names the columns.
- **A Postgres database**: paste a `postgres://` connection string (use a role that can only read) and give **A table** (`schema.table`) or **A SELECT query**, then click **Preview**.

For a CSV file or a database, the preview shows the columns with a suggested field type and their first value, read from the start of the source (a CSV's first 1,000 rows, a database's first 200). Pick the **Columns to sync**, change their types if you like, and pick the key column that identifies a row, or **Row number**. Then choose how often it syncs and click **Sync table**.

Your server may offer more sources, read through your own connected account at their provider; connect it from the same dialog, and disconnect it any time.

For a table or view, **Sync both ways** (off by default) makes edits in the synced table go back to the source: see [Sync both ways](#sync-both-ways).

Creators and owners add synced tables. Everyone who can read the table sees where it comes from and when it last synced; editors can click **Sync now**; creators and owners change the schedule, pause, resume or stop the sync.

## How syncing works

A sync runs when it is created, on its schedule (every 5 minutes, every hour, every day, or only when you click **Sync now**) and when it is resumed. Each run reads the source as the person who created the sync, with their access as it is at that moment: a table they can no longer read, or a synced table they can no longer edit, pauses the sync. A personal view can be synced by its owner only.

A run compares the source with the synced table by key: it adds records for new keys, updates only the cells that changed and deletes the records whose key left the source. A run over an unchanged source writes nothing. A CSV file whose server says it hasn't changed since the last run (by its ETag or last-modified date) isn't downloaded again.

Synced fields are read-only, unless the source [syncs both ways](#sync-both-ways). You can add your own fields to a synced table, such as notes or a status, and edit them as usual; the sync leaves them alone. Fields copied from another table keep their type when it is a plain value (text, numbers, dates, selects and the like); others, such as links, lookups or attachments, become their text. The **Sync source** field holds each record's key.

The **Sync settings** menu in the table header changes the schedule, pauses the sync or stops it. **Stop syncing** keeps the table's records: it becomes an ordinary, editable table.

## Sync from more than one source

A synced table can bring together records from up to 10 sources, for example the same list kept in two bases, or a table and a CSV file. A table keeps working exactly as before until someone adds a second source.

To add one, open **Sync settings** in the table header and click **Add a source…** (creators and owners). Pick the source as for a new synced table, then choose where each of its fields (or columns) goes:

- **An existing synced field** of the table. It must take the source's values as they are: a field of the same type, or a text field (single line or long text), which takes any value as text. Any other mapping is refused, rather than converted.
- **A new field**, added to the table as a synced field.

The source's primary field (or first column) goes into the table's primary field by default. Fields you added to the table yourself can't take a source's values: they stay editable.

Each source is a sync of its own: it has its own schedule, pause and resume, run history and field mapping, and it runs as the person who added it, with their access checked at every run. With more than one source, the table header says how many there are; **Sources** lists them, with **Sync now**, the schedule, **Pause**, **Resume** and **Remove** for each one. **Sync now** in the header runs every active source, and **Pause all sources** and **Stop syncing** act on all of them.

### Which records belong to which source

Each record belongs to exactly one source: its identity is the source it came from plus its key. Once a table has a second source it gets a **Sync source ID** field next to **Sync source**: it holds the id of the source each record came from. Records synced while the table had one source keep an empty **Sync source ID**; they belong to the table's first source, and their keys aren't rewritten.

Sources own separate records:

- A run of one source adds, updates and deletes only that source's records. It never changes another source's records, even when they share a key.
- The same key from two sources makes two records, one per source. Records are never merged across sources, and no source overwrites another's values.
- A key that appears twice in one source is skipped after its first record, as with a single source.
- A run that fails or pauses deletes nothing, and doesn't touch other sources' records.

### Remove a source

**Remove** in **Sources** takes one source off the table. Its records stay in the table, owned by no source: no run updates or deletes them any more. Like every record of a synced table, they stay read-only while the table has other sources; once the last source is gone, the whole table is ordinary and editable. Fields that no remaining source fills become ordinary, editable fields. The other sources keep running.

Removing the last source is the same as **Stop syncing**: the table keeps all its records and becomes an ordinary, editable table.

## Sync both ways

A source that is a table or view in OpenRows can sync both ways: edits to its records in the synced table are written back to the source, and deleting one of its records in the synced table deletes it in the source. CSV files, databases and connected apps always sync one way.

### Turn it on

Tick **Sync both ways** when you add the synced table or a source, or turn it on later: **Sync settings** → **Sync both ways** for a table with one source, or **Both ways** next to the source in **Sources**. Only creators and owners can, and only when they can edit the source's records themselves (see [Permissions](#permissions)). The person who turns it on becomes the source's creator: every run reads and writes the source as them.

Turning it on queues a run. That first run takes the source's values as the starting point, and once it is done the source's records become editable in the synced table. Turning it off makes the source one-way again: its records are read-only, and the next run brings them back in line with the source, so edits not yet written back are lost.

Nothing changes for a sync until someone turns this on: one-way syncs keep working exactly as before.

### Which fields can be edited

Only fields copied as themselves can be edited in the synced table and written back: text, numbers, dates, checkboxes, selects, ratings, durations, emails, URLs, phone numbers and barcodes, mapped into a field of the same type. They become editable on the records of that source only. These stay read-only:

- fields copied as text (links, lookups, rollups, formulas, attachments, people and the like), and fields mapped into a text field of another type;
- the field a source is keyed by (its **Match records by** field), so a record keeps its identity;
- the **Sync source** and **Sync source ID** fields;
- records of one-way sources, and records no source owns any more.

Fields you added to the synced table yourself stay editable as usual and are never written back. New records can't be added in the synced table: add them in the source.

### Who wins

Each run compares both sides with the values it last applied to each record, field by field:

- Only the source changed: the synced record takes the source's value, as for a one-way sync.
- Only the synced record changed: the value is written to the source record.
- Both changed the same field since the last run: the record that was updated last wins (by each record's last modified time). If both were updated at the same moment, the source wins.
- Fields that only one side changed are applied in their own direction, even when the other side wins another field of the same record.

A value written back that the source already holds changes nothing. After a run has written a change back, both sides and the last applied values agree, so the next run, of this sync or of another one syncing the same source, writes nothing for it.

### Deleting records

- **A record deleted in the source** is deleted in the synced table, as for a one-way sync. An edit of it in the synced table doesn't bring it back, and nothing is written to the source.
- **A record deleted in the synced table** is deleted in the source at the end of the next run, as long as the sync's creator may delete records there; otherwise the sync pauses (see [Permissions](#permissions)) and the synced record stays deleted. An edit of the source record meanwhile doesn't bring it back. Restoring the synced record from the trash before that run ends cancels the delete.
- **A view's filter**: when a source record no longer matches the view, it leaves the synced table, but it is never deleted from the source table. It comes back if it matches the view again. Deleting a synced record of a view still deletes it in the source table.

As for one-way syncs, deletes happen only at the end of a run, once the whole source has been read. A run that fails or pauses partway deletes nothing on either side, and the next run picks up from there; a run over unchanged tables writes nothing on either side.

### Permissions

A two-way run writes to the source as its creator, with their access as it is at that moment, exactly as if they made the change themselves:

- Turning it on needs edit access to the source's records: an editor or more there, allowed to edit records by the table's permissions. Without it, the change is refused. Resuming a two-way source checks the same for the person resuming it.
- If the creator can no longer edit the source's records (or a field being written back, add a select option a value written back needs, or delete a record that was deleted in the synced table), the run pauses with **Can no longer edit the source** and writes nothing more to the source. Changes it already wrote in that run stay; the synced table keeps its edits and deletes, which go back once the sync is resumed by someone who may make them.
- A run never writes into a base the creator can't edit, including a source in another base or workspace.

Anyone who can edit the synced table can edit the source's records through it, within the creator's rights in the source. Turn two-way on only for synced tables whose editors should be able to do that.

### Loops

Two-way syncs never form a loop:

- A table can't sync both ways with itself, and a synced table is never a source.
- One two-way sync is enough for a pair of tables: a second one between the same tables, in either direction, is refused.
- More generally, a two-way sync is refused when the two tables are already joined by a chain of two-way syncs.

Several synced tables can each sync both ways with the same source. An edit written back from one of them reaches the others as an ordinary source change, and goes no further.

### With several sources

Two-way is set per source. On a table with several sources, only the records of a two-way source are editable (in the fields that source writes back) and deletable, and its runs write back only its own records. The other sources' records stay read-only, and the limits below apply unchanged.

## Large sources

A sync copies up to 100,000 records. Before writing anything, a run counts the source (or reads it to the end, for a CSV file or a database). If it has more, the sync pauses and says so, and the synced table keeps the records it has. Make the source smaller, for example with a view's filter or a query's `WHERE`, then resume the sync.

A run reads the source a page at a time and writes its changes in batches, so a large first run takes a while: records appear in the table while it runs. Records are deleted only at the end of a run, once the whole source has been read. If a run fails partway, for example because the download breaks off or the database stops answering, the changes it wrote so far stay, nothing is deleted, and the next run picks up from there. One run of a source goes at a time; **Sync now** during a run doesn't start a second one. The 100,000-record limit applies to each source on its own: a source past it pauses, and the table's other sources keep running.

## Limits

- 100,000 records and 100 fields per source.
- 10 sources per synced table, and 50 sources per base (each source of a table counts, the first one too).
- A CSV file up to 200 MB, each of its rows up to 16 million characters; a database source's rows up to 200 MB as text. Cells longer than 100,000 characters are cut.
- A database query up to 10,000 characters, one SELECT (or WITH … SELECT) statement, run in a read-only transaction. Each page of rows must arrive within 30 seconds.
- A run reads a CSV file or a database within 10 minutes.
- The table's sync history shows the last 20 runs.

## When a sync pauses or fails

The table header shows the sync's state and its last runs. A paused sync says why:

- **Paused** by someone: resume it to run it again.
- **Access lost**: its creator can no longer read the source, edit the synced table or use their connected account. Resuming makes you the sync's reader, with your own access.
- **Source deleted**: the source table or view was deleted.
- **Too many records**: the source has more than 100,000 records.
- **Can no longer edit the source** (two-way): its creator can no longer edit the source's records or a field being written back, add a select option a value written back needs, or delete a record deleted in the synced table. Nothing more was written to the source. Resuming makes you the sync's reader and writer, if you may edit the source.

A failed run keeps the sync active and says what went wrong, such as a URL that answers with a web page or a key column that left the source. The next run tries again.

A server reaches CSV URLs and databases at public addresses only, unless its administrator allows more with `OUTBOUND_HTTP_ALLOW`.
