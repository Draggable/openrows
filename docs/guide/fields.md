# Fields

Every field type in OpenRows, its options, how type conversions work, links, lookups and rollups, formulas and their functions, and per-field edit permissions.

## Adding and editing fields

Click the **Add field** button (the "+" at the right end of the grid's header) to create a field. The field editor opens as a popover: give the field a name, pick a type, set its options, and press **Create field** (or Ctrl/Cmd Enter).

The type picker groups types into **Basic**, **Choice**, **Contact**, **People & links** and **Computed**. Type in **Search types…** to filter, use the arrow keys and press Enter to pick one.

Owners and creators get these actions in a column header's menu:

| Menu item | What it does |
| --- | --- |
| Edit field | Opens the field editor |
| Rename field | Opens the editor with the name selected |
| Change field type | Opens the editor on the type picker |
| Edit description | Opens the editor on the description |
| Edit permissions | Who may edit the field's cells (see below) |
| Duplicate field | Opens the editor prefilled with "Name copy", the same type, options and description. Cell values are not copied |
| Insert left / Insert right | Creates a new field next to this one |
| Delete field | Moves the field to the trash after a confirmation, with an **Undo** toast |

Depending on your role, the menu also has Move left/right, Freeze up to this field, Select column, Reset width and Hide field. Hiding is a view setting: see [Views](views.md).

The primary field (the first column, which names each record) can't be deleted or hidden, and it can't be a link, formula, button, lookup, rollup or count. You can't delete a field that a lookup, rollup, count or formula reads: change or remove those fields first. Deleted fields can be restored from the trash: see [Bases, tables and records](bases-and-tables.md).

## Field types

| Type | Category | What it stores | Options and notes |
| --- | --- | --- | --- |
| Single line text | Basic | One line of text, up to 100,000 characters | Line breaks become spaces |
| Long text | Basic | Multi-line text, up to 100,000 characters | **Enable rich text formatting**: headings, bold, italic, strikethrough, inline code, code blocks, quotes, bulleted, numbered and check lists, and links (http, https and mailto only). Stored as Markdown |
| Attachment | Basic | Files | Upload in the cell or the expanded record; images get thumbnails |
| Checkbox | Basic | On or off | **Icon** (check, star, heart, thumbs up, flag, dot) and **Color** |
| Number | Basic | A decimal number | **Decimal places** (0 to 8), **Allow negative numbers** |
| Currency | Basic | An amount in one currency | **Currency code** (ISO code such as USD, EUR), decimal places (default 2), allow negative numbers |
| Percent | Basic | A percentage | Decimal places, allow negative numbers. Typing `50` or `50%` stores 50% |
| Date | Basic | A calendar day, no time | **Date format**: Local, Friendly (October 25, 2026), US (10/25/2026), European (25/10/2026), ISO (2026-10-25) |
| Date and time | Basic | A point in time | Date format, **Time format** (12 hour or 24 hour), **Time zone** (default UTC; times you type are read in it) |
| Duration | Basic | A length of time | **Duration format**: h:mm, h:mm:ss, h:mm:ss.s, h:mm:ss.ss, h:mm:ss.sss. A plain number is read as minutes in h:mm, as seconds otherwise |
| Rating | Basic | 1 to the maximum | **Maximum** (1 to 10, default 5), **Icon**, **Color** |
| Barcode | Basic | A code and its symbology | EAN-13, EAN-8, UPC-A, UPC-E, Code 128, Code 39, ITF, QR and Data Matrix; check digits are verified. The cell shows the code's text |
| Single select | Choice | One choice from a list | **Choices**: add, rename, recolor, reorder (drag, or Alt+Up/Down), remove. Up to 1,000 choices |
| Multiple select | Choice | Any number of choices | Same choices editor. Pasted text is split on commas |
| Email | Contact | An email address | Text that isn't an address is left empty |
| URL | Contact | An http or https link, up to 2,048 characters | A bare domain gets `https://`; other schemes are refused |
| Phone number | Contact | A phone number as typed | Digits, spaces, `+ - ( ) . /` and an optional extension |
| User | People & links | Collaborators of the base | **Allow adding multiple collaborators** (up to 100 per cell), **Notify collaborators when they're added**. Removed members show as "Former member" |
| Created by | People & links | Who created the record | Read-only |
| Last modified by | People & links | Who last changed the record | Read-only |
| Link to another record | People & links | Records of another table (or the same table) | See [Linked records](#linked-records) |
| Autonumber | Computed | A unique, increasing number per record | Read-only |
| Created time | Computed | When the record was created | Date format, time format, time zone. Read-only |
| Last modified time | Computed | When any field of the record last changed | Date format, time format, time zone. Read-only |
| Lookup | Computed | Values of a field in the linked records | See [Lookups, rollups and counts](#lookups-rollups-and-counts) |
| Rollup | Computed | One value aggregated from the linked records | See [Lookups, rollups and counts](#lookups-rollups-and-counts) |
| Count | Computed | How many records a link field links to | 0 when there are none |
| Formula | Computed | The result of a formula over the record's fields | See [Formulas](#formulas) |
| Button | Computed | A clickable button in each cell | **Button label** (default "Open") and **When clicked**: **Open a URL** (the URL comes from a formula; only http and https results work, and they open in a new tab) or **Run automations** (see [Automations](automations.md)) |

Read-only and computed fields can't be typed into; OpenRows fills them for you.

## Converting field types

Change a field's type or options from **Change field type** or **Edit field**. Before you save, a conversion preview runs the conversion over the first 100 records and shows:

- "All N values in N records convert without loss." when nothing changes, or
- a warning when values would be cleared or changed (rounding, dropped choices, a removed choice still in use), ending with "This can't be undone.", and
- examples as before → after, with cleared values shown as "Empty".

Converting into a computed type (formula, lookup, rollup, count) discards the stored values, because the field fills its own. Things to know:

- Values that can't be read as the new type become empty (for example text that isn't a date).
- Converting to a select adds a choice for every value that doesn't match an existing one.
- Converting to a link matches each value against the primary field of the linked table, ignoring case. Names that match nothing become new records in the linked table.
- Converting a link to another type turns the linked records' names into values (text joins them) and moves the inverse link field to the trash.
- Converting to text uses the values as they're displayed.

## Linked records

A **Link to another record** field connects records across tables of the same base. Options:

- **Link to table**: any table of the base. It can't be changed after the field is created.
- **Allow linking to multiple records**: on by default; turn it off for one linked record per cell.
- **Limit record selection to a view**: only records that a view of the linked table shows can be linked. This is enforced on every write, not only in the picker.

Creating a link adds a matching field to the linked table, named after this table (with a number if that name is taken). Both sides always stay in sync. A link to the same table has no inverse field. Deleting either side moves both fields to the trash; restoring one brings back the pair with its links.

Cells show the linked records' primary field values ("Unnamed record" when it's empty). You can paste or import names: they're matched against the linked table's primary field. Deleted records disappear from link cells and come back if the record is restored.

## Lookups, rollups and counts

These fields read through a link field of the same table. If the table has none, the editor asks you to add a "Link to another record" field first.

- **Lookup**: pick the **Linked record field**, then the **Field to look up** in the linked table. The cell lists each linked record's value, in link order.
- **Rollup**: pick the linked record field and the **Field to roll up**, then an **Aggregation**:

| Aggregation | Function |
| --- | --- |
| Sum | SUM |
| Average | AVG |
| Minimum | MIN |
| Maximum | MAX |
| Count numbers | COUNT |
| Count non-empty values | COUNTA |
| Count all values | COUNTALL |
| All true | AND |
| Any true | OR |
| An odd number true | XOR |
| Join with a separator | ARRAYJOIN (set the **Separator**) |
| Unique values | ARRAYUNIQUE |
| Non-empty values | ARRAYCOMPACT |
| Concatenate | CONCATENATE |

Sum, Average, Minimum and Maximum also have **Decimal places** (or Automatic).

- **Count**: pick the linked record field. The cell is the number of linked records.

Computed values update when the linked records change. A field can't read itself through a chain of lookups, rollups or formulas; OpenRows refuses a circular reference. After a large change, a spinning icon in the column header ("Updating values. Some may be out of date for a moment.") shows that values are still being recomputed.

## Formulas

A formula field computes a value for each record from its other fields, like Airtable formulas. The editor highlights the formula, completes field names (type `{`) and functions (Ctrl Space lists everything), shows help for the function under the cursor, marks errors where they are, and previews the **Result type** and the result for the **First record** before you save. You can't save an empty or invalid formula.

### Syntax

- Reference a field as `{Field name}`. A single-word name also works without braces (`Price * 2`). Inside braces, write `\}` for a `}` in a name. References survive renames.
- Text goes in single or double quotes, with backslash escapes (`\n`, `\t`, `\"`).
- `TRUE` and `FALSE` are booleans. Function names ignore case.
- Operators, from tightest to loosest: `*` `/`, then `+` `-`, then `&` (joins text), then comparisons `=` `!=` (or `<>`) `<` `<=` `>` `>=`. Use parentheses to group.

```
IF({Status} = "Done", "Closed on " & DATETIME_FORMAT({Closed at}, "YYYY-MM-DD"), "Open")
```

A formula can be up to 10,000 characters, and parentheses and calls can nest up to 64 levels.

### Results

| Result type | Shown as | Options |
| --- | --- | --- |
| Number | A number | **Decimal places** (Automatic or 0 to 8) |
| Text | Text | |
| Date | A date and time | **Time zone** (default UTC) |
| Boolean (1 or 0) | 1 or 0 | |
| List | Items joined with ", " | |

A formula that fails for a record shows `#ERROR!`. Dates are computed in UTC unless you use `SET_TIMEZONE`. Formulas that call `NOW()` or `TODAY()` are refreshed every hour, not continuously; `TODAY()` is the current day in UTC.

### Functions

OpenRows supports 84 functions.

| Category | Functions |
| --- | --- |
| Text | ARRAYJOIN, CONCATENATE, ENCODE_URL_COMPONENT, FIND, LEFT, LEN, LOWER, MID, REPLACE, REPT, RIGHT, SEARCH, SUBSTITUTE, T, TRIM, UPPER, REGEX_MATCH, REGEX_EXTRACT, REGEX_REPLACE |
| Logical | AND, OR, XOR, NOT, IF, SWITCH, BLANK, ERROR, ISERROR, TRUE, FALSE |
| Numeric | ABS, AVERAGE, CEILING, COUNT, COUNTA, COUNTALL, EVEN, EXP, FLOOR, INT, LOG, MAX, MIN, MOD, ODD, POWER, ROUND, ROUNDDOWN, ROUNDUP, SQRT, SUM, VALUE |
| Date and time | CREATED_TIME, DATEADD, DATESTR, DATETIME_DIFF, DATETIME_FORMAT, DATETIME_PARSE, DAY, HOUR, IS_AFTER, IS_BEFORE, IS_SAME, LAST_MODIFIED_TIME, MINUTE, MONTH, NOW, SECOND, SET_LOCALE, SET_TIMEZONE, TIMESTR, TONOW, FROMNOW, TODAY, WEEKDAY, WEEKNUM, WORKDAY, WORKDAY_DIFF, YEAR |
| Lists | ARRAYCOMPACT, ARRAYFLATTEN, ARRAYUNIQUE, ARRAYSLICE |
| Record | RECORD_ID |

Notes:

- Date units for DATEADD, DATETIME_DIFF, IS_SAME, TONOW and FROMNOW: `milliseconds` (`ms`), `seconds` (`s`), `minutes` (`m`), `hours` (`h`), `days` (`d`), `weeks` (`w`), `months` (`M`), `quarters` (`Q`), `years` (`y`), singular or plural.
- DATETIME_FORMAT and DATETIME_PARSE use Airtable's format tokens, such as `YYYY-MM-DD` or `D MMMM YYYY h:mm A`.
- WEEKDAY and WEEKNUM take an optional week start, "Sunday" or "Monday". WORKDAY and WORKDAY_DIFF take optional holidays.
- LAST_MODIFIED_TIME() with field arguments gives when those fields last changed.
- The REGEX functions don't support backreferences or lookaround.
- Aggregates such as SUM and MAX accept lists (lookups, multiple selects) and skip text and blanks.

## Field descriptions

Add a description under **Description** in the field editor (up to 2,000 characters), or with **Edit description** in the column menu. It shows as an info icon in the column header, with the description as its tooltip.

## Edit permissions per field

Owners and creators can limit who may change a field's values with **Edit permissions** in its column menu. Under **Who can edit this field**, choose:

- **Editors and up** (the default)
- **Creators and up**
- **Specific people**: pick roles and collaborators
- **Nobody (read-only)**

Everyone who can see the table still sees the field; this only limits editing. A restricted field shows a lock icon in its header. When a field is restricted, **Allow this field to be filled through forms** lets public forms set it on the records they create (see [Forms](forms.md)). Table-level permissions (who may add, delete and edit records) also apply; both must allow a change. See [Sharing and permissions](sharing.md).

On the hosted service, edit permissions depend on your plan (see https://openrows.io/pricing); self-hosted instances have no limits.
