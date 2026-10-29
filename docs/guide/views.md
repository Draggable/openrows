# Views

A view is one way of looking at a table: a grid, a board, a calendar, cards, a timeline, a nested list or a form, each with its own filters, sorts and layout.

## Creating and managing views

A table's views are listed under **Views** in the base sidebar. To add one, click **Create view** and pick a type: **Grid**, **Kanban**, **Calendar**, **Gallery**, **Timeline**, **List** or **Form**. Tick **Only me** in the same menu to make the new view personal. The new view gets the type's name ("Kanban", "Calendar 2" and so on) and opens straight away.

Open a view's **…** menu in the sidebar for:

| Action | What it does |
| --- | --- |
| **Rename** | Renames the view (or double-click its name) |
| **Duplicate** | Copies the view with its filters, sorts and layout |
| **Share view** / **Share form** | Makes a public link to the view, or to a form view's form (owners and creators) |
| **Lock view** / **Unlock view** | Stops others changing the view's setup (owners and creators) |
| **Make personal** / **Make collaborative** | Changes who sees the view (only the person who made it) |
| **Move up** / **Move down** / **Move to section** | Changes where the view sits in the sidebar; you can also drag it |
| **Delete view** | Moves the view to the base's trash, where you can restore it |

Editors and above can create, rename, duplicate, reorder and delete views. A table always keeps at least one collaborative view, so the last one can't be deleted or made personal.

### Sections

Sections are named folders that group a table's views in the sidebar. Click **New section** under the views, then drag views into it or use **Move to section** in a view's menu. A section's **…** menu has **Rename section**, **Move up**, **Move down** and **Delete section**. Deleting a section keeps its views: they move out of the section.

### Collaborative, personal and locked views

| Kind | Who sees it | Who can change its setup |
| --- | --- | --- |
| Collaborative (the default) | Everyone with access to the table | Editors and above |
| Personal (person icon) | Only the person who made it | The person who made it |
| Locked (lock icon) | Everyone with access to the table | Owners and creators only |

Changes you can't save still work for you: commenters and read-only collaborators, and editors on a locked view, can filter, sort, group, hide fields and search, but the changes last only until you leave the page. They never change the view for anyone else.

## The view toolbar

Grid views have the full toolbar. Other layouts have their own controls plus the filter, sort (except the timeline) and find tools described here.

### Filter

**Filter** shows a count of active conditions, as in "Filter (2)". Click **Add condition** to pick a field, an operator and a value. Join conditions with **and** or **or**, and click **Add condition group** for one nested level of conditions (for example, "Status is Done or (Priority is High and Owner is Me)"). A view holds up to 50 conditions. A condition without a value is ignored until you fill it in.

The operators depend on the field type:

| Fields | Operators |
| --- | --- |
| Text | is, is not, contains, does not contain, is empty, is not empty |
| Numbers, currency, percent, duration, rating | =, ≠, <, ≤, >, ≥, is empty, is not empty |
| Dates | is, is not, is before, is after, is on or before, is on or after, is within, is empty, is not empty |
| Single select | is, is not, is any of, is none of, is empty, is not empty |
| Multiple select | has any of, has all of, is exactly, has none of, is empty, is not empty |
| User | has any of, has all of, is exactly, has none of, is empty, is not empty |
| Created by, last modified by | is, is not, is any of, is none of, is empty, is not empty |
| Linked records | contains, does not contain (record names), has any of, has none of (pick specific records, up to 100), is empty, is not empty |
| Attachments | contains, does not contain (file names), is empty, is not empty |
| Formula, rollup | the number operators, plus contains and does not contain |
| Lookup | contains, does not contain, is empty, is not empty |
| Checkbox | is checked or unchecked | Date conditions compare with **today**, **tomorrow**, **yesterday** or an **exact date**; **is within** takes the past or next week, month or year. People conditions offer **Me**, which always means whoever is looking at the view, so one shared view can show "my tasks" to everyone.

### Sort and group

**Sort** orders records by up to 10 fields: **Sort by** the first, **then by** the others. Directions are worded for the field, such as A → Z, 1 → 9, old → new or first → last for select options. A sort replaces any manual order.

**Group** (grid only) groups records by up to 3 fields. Each group starts with a header band showing the value and its record count.

### Hide fields

**Hide fields** lists every field with a switch. **Hide all** and **Show all** do what they say. Reorder fields with the arrow buttons or Alt+Up/Down. The primary field is always shown.

### Row height

**Row height** has four sizes: **Short**, **Medium**, **Tall** and **Extra tall**.

### Row colours

**Color** tints rows in the grid:

- **None**: no colours.
- **By select field**: each row takes the colour of its option in a single select field.
- **By conditions**: add up to 20 colour conditions with **Add color condition**. Each has a colour and conditions that must all be true. A record takes the colour of the first condition it matches.

Row colours show only in grid views.

### Find in view

**Find in view** (Ctrl+F or Cmd+F in the grid) searches the view's records. The grid highlights matching cells and shows your position, as in "3 of 12". Press Enter for the next match, Shift+Enter for the previous one and Esc to close. Searches aren't saved with the view.

### More view actions

The **…** button in the grid toolbar has **Import CSV…** (if you can add records) and **Download CSV**, which exports the view as you see it. See [Bases, tables and records](bases-and-tables.md).

## Grid

The grid is the spreadsheet view. For editing, copy and paste, the fill handle and undo, see [Bases, tables and records](bases-and-tables.md). Column headers have a menu with **Freeze up to this field**, **Unfreeze columns**, **Move left**, **Move right**, **Select column**, **Reset width** and **Hide field**, plus field actions for people who can edit the schema. Drag a header to reorder columns and drag its right edge to resize. The summary bar at the bottom shows sums under number fields and counts under checkboxes.

## Kanban

A kanban view shows records as cards in stacks, one stack per option of a single select field or per person in a user field (one person per cell). The first stack holds records with no value ("Uncategorized", or "No *field name*" for people).

- **Stacked by** chooses the field. A new kanban view asks for it first.
- **Customize cards** sets the **Cover image** (an attachment field), **Collapse empty stacks** and the **Fields on cards**.
- Drag a card to another stack to change its value. Where you drop it within a stack is saved as the view's manual order, unless the view is sorted.
- **New record** at the bottom of a stack creates a record with that stack's value.
- **Add stack** at the end of the board adds an option to the single select (owners and creators).

Keyboard: arrow keys, Home and End move between cards; Enter or Space opens a card; Alt+Up/Down moves a card within its stack; Alt+Left/Right moves it to the top of the next stack.

## Calendar

A calendar view places records on days by a date field.

- **Date fields** sets up to 5 pairs of a start field and an optional end field (**No end (single day)**). Records with an end date span several days. Date, date and time, created time and last modified time fields can be used, but only date and date-and-time fields can be moved.
- In the same menu, **Colour events by** colours events by a single select field instead of by date field.
- Switch between **Month**, **Week** and **Day**, and use **Today** and the arrows to move around.
- Drag an event to another day, or drag the end of a range to change its length. The **+** on a day creates a record on that day.
- **Undated** opens a panel of records without a date. Drag one onto a day, or click its calendar button to schedule it on the day you're viewing.

Keyboard: Enter opens an event; Alt+Left/Right moves it a day; Alt+Up/Down moves it a week (a day in the Day layout); Alt+Shift+Left/Right shortens or lengthens a range. The week starts on Sunday. A calendar shows up to 1,000 records in the visible range; filter the view or switch to a week if you have more.

## Gallery

A gallery shows records as cards. **Customize cards** sets:

- **Cover image**: an attachment field whose first image tops each card. Tick **Fit the whole image** to show all of it instead of cropping.
- **Card size**: **Small**, **Medium** or **Large**.
- **Fields on cards**: the fields under the title (the primary field).

Arrow keys move between cards and Enter opens one. **New record** adds a card.

## Timeline

A timeline draws each record as a bar from its start date to its end date. Open **Timeline settings** to choose:

| Setting | What it does |
| --- | --- |
| **Start date**, **End date** | The date fields the bars span |
| **Group by** | Groups rows under the options of a single select |
| **Colour by** | Colours bars by a single select |
| **Dependencies (Gantt)** | A link field to records in the same table. Arrows run from each record it waits for, and turn red when the record starts before its predecessor ends |

Zoom by **Day**, **Week** or **Month**, and use **Today**, **Earlier** and **Later** to move along. Drag a bar to move it, or drag either edge to change its dates. Keyboard: Up/Down moves between bars; Enter opens one; Alt+Left/Right moves the bar a day (a week in the week and month zooms); Alt+Shift+Left/Right changes its end date. The timeline has no sort menu and shows up to 1,000 bars at a time.

## List

A list view shows records as a tree. Open **Customize list** and choose a field in **Nest under**, a link to records in the same table (for example, "Parent task"). Each record then sits under the first record that field links to. Pick **Don't nest** for a flat list. **Fields in rows** chooses what shows beside each title.

Click a chevron, or press Left or Right, to collapse or expand a branch. Enter opens a record. A list loads up to 5,000 records.

## Form

A form view turns a table into a form that adds a record per submission. See [Forms](forms.md).

## Sharing a view

Owners and creators can share a grid, kanban, calendar, gallery, timeline or list view with a read-only public link, optionally with a password or an email-domain limit, and embed it on a website. See [Sharing and permissions](sharing.md).
