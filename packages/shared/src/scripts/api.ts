/**
 * Browser scripts: the script API's members, for the editor's autocomplete and the
 * Scripts page's reference. Kept next to the runtime (sandbox.ts) that implements them.
 */

export interface ScriptApiMember {
  /** What the editor inserts, e.g. `getTable`. */
  name: string;
  /** The signature shown, e.g. `getTable(nameOrId): Table`. */
  signature: string;
  doc: string;
  kind: 'method' | 'property';
}

const m = (signature: string, doc: string): ScriptApiMember => ({
  name: signature.replace(/\(.*$/, ''),
  signature,
  doc,
  kind: 'method',
});
const p = (signature: string, doc: string): ScriptApiMember => ({
  name: signature.replace(/:.*$/, ''),
  signature,
  doc,
  kind: 'property',
});

/** The script's globals and the objects it reaches, by name. */
export const SCRIPT_API: Record<string, readonly ScriptApiMember[]> = {
  base: [
    p('id: string', "The base's id."),
    p('name: string', "The base's name."),
    p('tables: Table[]', 'Every table of the base.'),
    m('getTable(nameOrId): Table', 'A table by name or id; throws when there is none.'),
    m('getTableIfExists(nameOrId): Table | null', 'A table by name or id, or null.'),
  ],
  table: [
    p('id: string', "The table's id."),
    p('name: string', "The table's name."),
    p('description: string | null', "The table's description."),
    p('primaryField: Field', "The table's primary field."),
    p('fields: Field[]', "The table's fields."),
    p('views: View[]', "The table's views."),
    m('getField(nameOrId): Field', 'A field by name or id; throws when there is none.'),
    m('getFieldIfExists(nameOrId): Field | null', 'A field by name or id, or null.'),
    m('getView(nameOrId): View', 'A view by name or id; throws when there is none.'),
    m('getViewIfExists(nameOrId): View | null', 'A view by name or id, or null.'),
    m(
      'selectRecordsAsync(options?): Promise<RecordQueryResult>',
      'Every record you can see, with `{ fields, sorts: [{ field, direction }], recordIds }`.'
    ),
    m('selectRecordAsync(recordId): Promise<Record | null>', 'One record, or null.'),
    m('createRecordAsync(fields): Promise<string>', 'Creates a record; answers its id.'),
    m(
      'createRecordsAsync([{ fields }]): Promise<string[]>',
      'Creates up to 50 records; answers their ids.'
    ),
    m('updateRecordAsync(recordOrId, fields): Promise<void>', "Changes a record's cells."),
    m('updateRecordsAsync([{ id, fields }]): Promise<void>', 'Changes up to 50 records.'),
    m('deleteRecordAsync(recordOrId): Promise<void>', 'Moves a record to the trash.'),
    m('deleteRecordsAsync(recordsOrIds): Promise<void>', 'Moves up to 50 records to the trash.'),
  ],
  view: [
    p('id: string', "The view's id."),
    p('name: string', "The view's name."),
    p('type: string', "The view's type: grid, kanban, calendar, …"),
    m(
      'selectRecordsAsync(options?): Promise<RecordQueryResult>',
      "The view's records, in its order and with its filters."
    ),
    m('selectRecordAsync(recordId): Promise<Record | null>', 'One record of the view, or null.'),
  ],
  field: [
    p('id: string', "The field's id."),
    p('name: string', "The field's name."),
    p('type: string', "The field's type, e.g. singleLineText."),
    p('description: string | null', "The field's description."),
    p('options: object | null', "The field's options (choices, formats, …)."),
    p('isComputed: boolean', 'Whether the field is computed (formula, lookup, …): read-only.'),
  ],
  query: [
    p('records: Record[]', 'The records.'),
    p('recordIds: string[]', "The records' ids."),
    m('getRecord(recordId): Record', 'A record of the result by id.'),
  ],
  record: [
    p('id: string', "The record's id."),
    p('name: string', "The primary field's text."),
    p('createdTime: string', 'When it was created (ISO 8601).'),
    m('getCellValue(fieldOrNameOrId): unknown', 'A cell as stored.'),
    m('getCellValueAsString(fieldOrNameOrId): string', 'A cell as display text.'),
  ],
  input: [
    m('textAsync(label): Promise<string>', 'Asks for text.'),
    m(
      'buttonsAsync(label, options): Promise<unknown>',
      "Asks to pick a button: strings or `{ label, value, variant }`; answers the option's value."
    ),
    m('tableAsync(label): Promise<Table>', 'Asks to pick a table.'),
    m('viewAsync(label, table): Promise<View>', 'Asks to pick a view of the table.'),
    m('fieldAsync(label, table): Promise<Field>', 'Asks to pick a field of the table.'),
    m(
      'recordAsync(label, source): Promise<Record | null>',
      'Asks to pick a record of a table, a view, a query result or a list of records.'
    ),
  ],
  output: [
    m('text(value)', 'Shows text.'),
    m('markdown(source)', 'Shows Markdown.'),
    m('table(data)', 'Shows a table: a list of objects, a list of values or an object.'),
    m('inspect(value)', 'Shows a value as JSON.'),
    m('clear()', 'Clears the output.'),
  ],
  session: [p('currentUser: { id, name, email }', 'Who runs the script.')],
  console: [
    m('log(...values)', 'Writes to the console.'),
    m('warn(...values)', 'Writes a warning to the console.'),
    m('error(...values)', 'Writes an error to the console.'),
  ],
};

/** The globals a script sees. */
export const SCRIPT_GLOBALS = ['base', 'input', 'output', 'session', 'console'] as const;
