# Synced tables

A synced table copies its records from somewhere else and keeps them up to date: another table or view (in this base, another base, or another workspace you belong to), a CSV file at a URL, or a Postgres table or query. A synced table starts with one source and can sync from several. The sync goes one way: changes in a source reach the synced table, never the other way round.

## Add a synced table

In a base's sidebar, click **Sync data** and pick the source:

- **A table or view**: pick the base, the table and, optionally, a view (only its records then, as its filter shows them). Choose the fields to copy; the primary field always comes along. Records are matched by the source record, or by a field you pick as the key.
- **A CSV file at a URL**: paste the URL and click **Preview**. The first row names the columns.
- **A Postgres database**: paste a `postgres://` connection string (use a role that can only read) and give **A table** (`schema.table`) or **A SELECT query**, then click **Preview**.

For a CSV file or a database, the preview shows the columns with a suggested field type and their first value, read from the start of the source (a CSV's first 1,000 rows, a database's first 200). Pick the **Columns to sync**, change their types if you like, and pick the key column that identifies a row, or **Row number**. Then choose how often it syncs and click **Sync table**.

Your server may offer more sources, read through your own connected account at their provider; connect it from the same dialog, and disconnect it any time.

Creators and owners add synced tables. Everyone who can read the table sees where it comes from and when it last synced; editors can click **Sync now**; creators and owners change the schedule, pause, resume or stop the sync.

## How syncing works

A sync runs when it is created, on its schedule (every 5 minutes, every hour, every day, or only when you click **Sync now**) and when it is resumed. Each run reads the source as the person who created the sync, with their access as it is at that moment: a table they can no longer read, or a synced table they can no longer edit, pauses the sync. A personal view can be synced by its owner only.

A run compares the source with the synced table by key: it adds records for new keys, updates only the cells that changed and deletes the records whose key left the source. A run over an unchanged source writes nothing. A CSV file whose server says it hasn't changed since the last run (by its ETag or last-modified date) isn't downloaded again.

Synced fields are read-only. You can add your own fields to a synced table, such as notes or a status, and edit them as usual; the sync leaves them alone. Fields copied from another table keep their type when it is a plain value (text, numbers, dates, selects and the like); others, such as links, lookups or attachments, become their text. The **Sync source** field holds each record's key.

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

A failed run keeps the sync active and says what went wrong, such as a URL that answers with a web page or a key column that left the source. The next run tries again.

A server reaches CSV URLs and databases at public addresses only, unless its administrator allows more with `OUTBOUND_HTTP_ALLOW`.
