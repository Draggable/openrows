import type { FieldMeta, Primitive } from '@openrows/shared';
import {
  cellPrimitive,
  cellText,
  coerceValue,
  editorKind,
  fieldDef,
  sameValue,
} from '../cells/model';

/**
 * Copy and paste. A copied range goes to the clipboard as TSV (`text/plain`, what Excel,
 * Sheets and Airtable read and write) and as an HTML table carrying the cells' type-neutral
 * values (`toPrimitive`) in a `data-openrows` attribute, so a paste inside OpenRows is exact
 * while a paste from elsewhere goes through each target field's `coerce`. Pure, so it is
 * unit-tested without a DOM.
 */

/** Cells keyed by field id, as the record API takes them. */
export type Fields = Record<string, unknown>;

/** What a copy puts on the clipboard. */
export type ClipboardPayload = { text: string; html: string };

/** One pasted cell: the text, and the exact value when it was copied from OpenRows. */
export type PastedCell = { text: string; value?: Primitive };

const MARKER = 'data-openrows';

/** TSV from rows of cell text; cells with a tab, newline or quote are quoted ("" escapes). */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => (/[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join('\t')
    )
    .join('\n');
}

/**
 * Rows of cell text from TSV, as Excel and Sheets write it: tabs between cells, CRLF or LF
 * between rows, quoted cells may hold tabs, newlines and `""`. A trailing newline is dropped.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  let atCellStart = true;
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
      i += 1;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      atCellStart = true;
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      atCellStart = true;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    atCellStart = false;
    i += 1;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const unescapeHtml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * The clipboard payload of a range: `rows[r][c]` is the value of column `fields[c]` in the
 * r-th copied record.
 */
export function copyPayload(
  fields: readonly FieldMeta[],
  rows: readonly Fields[]
): ClipboardPayload {
  const texts = rows.map((r) => fields.map((f) => cellText(f, r[f.id])));
  const values = rows.map((r) => fields.map((f) => cellPrimitive(f, r[f.id])));
  const body = texts
    .map((row) => `<tr>${row.map((t) => `<td>${escapeHtml(t)}</td>`).join('')}</tr>`)
    .join('');
  const html = `<table ${MARKER}="${escapeHtml(JSON.stringify(values))}"><tbody>${body}</tbody></table>`;
  return { text: toTsv(texts), html };
}

/** The pasted grid: exact values when the HTML is OpenRows' own and matches the text. */
export function readClipboard(text: string, html = ''): PastedCell[][] {
  const rows = parseTsv(text);
  const match = html.match(new RegExp(`${MARKER}="([^"]*)"`));
  if (match?.[1] !== undefined) {
    try {
      const values = JSON.parse(unescapeHtml(match[1])) as Primitive[][];
      if (
        Array.isArray(values) &&
        values.length === rows.length &&
        values.every((v, r) => Array.isArray(v) && v.length === rows[r]?.length)
      ) {
        return rows.map((row, r) =>
          row.map((t, c) => ({ text: t, value: values[r]?.[c] ?? null }))
        );
      }
    } catch {
      // Not ours after all: fall back to the text.
    }
  }
  return rows.map((row) => row.map((t) => ({ text: t })));
}

/** One record's cell writes, by its row in the view. */
export type RowWrite = { row: number; fields: Fields };

export type PastePlan = {
  /** Writes into existing rows (only cells that change). */
  updates: RowWrite[];
  /** New records past the last row. */
  creates: Fields[];
  /** Pasted cells the target field couldn't read (left unchanged). */
  unreadable: number;
  /** Some cells name select options to create: write with `typecast`. */
  typecast: boolean;
  /** The rows and columns the paste covers, for selecting them afterwards. */
  rows: number;
  cols: number;
};

/**
 * The option names a pasted cell gives a select field that it doesn't have yet, for a
 * `typecast` write; empty for other fields.
 */
export function missingOptions(field: FieldMeta, cell: PastedCell): string[] {
  const { def, options } = fieldDef(field);
  const input = cell.value !== undefined ? cell.value : cell.text;
  if (!def.unknownChoices || input === null) return [];
  try {
    return def.unknownChoices(input, options as never);
  } catch {
    return [];
  }
}

const isLink = (field: FieldMeta) => fieldDef(field).def.storage.kind === 'link';

/**
 * The value a pasted cell becomes in `field`, `undefined` when it can't be read. With `typecast`
 * (schema roles), a select cell naming options the field lacks stays the pasted names, for the
 * server to create.
 */
export function pastedValue(field: FieldMeta, cell: PastedCell, typecast = false): unknown {
  const empty = fieldDef(field).def.emptyValue;
  // Links: the names (or ids) go to the server, which matches them by primary field.
  if (isLink(field)) {
    const input = cell.value !== undefined ? cell.value : cell.text.trim();
    return input === null || input === '' || (Array.isArray(input) && !input.length)
      ? empty
      : input;
  }
  if (typecast && missingOptions(field, cell).length > 0) {
    return cell.value !== undefined ? cell.value : cell.text.trim();
  }
  if (cell.value !== undefined) return coerceValue(field, cell.value) ?? empty;
  if (cell.text.trim() === '') return empty;
  const value = coerceValue(field, cell.text);
  return value === null ? undefined : value;
}

/**
 * Where a paste lands: from the top-left of the selection, one clipboard cell per grid cell.
 * A selection larger than the clipboard and a whole multiple of it in both directions (one cell
 * into a range, say) repeats it to fill the selection, as in Airtable and Sheets. Columns past
 * the last one are dropped; rows past the last one become new records. Read-only and computed
 * columns are skipped. `getRow` gives the current cells of a row, for skipping unchanged ones.
 * `typecast` (owners and creators) keeps unknown select names for the server to create.
 */
export function planPaste(
  cells: readonly PastedCell[][],
  target: { top: number; left: number; bottom: number; right: number },
  columns: readonly FieldMeta[],
  totalRows: number,
  getRow: (row: number) => Fields | undefined,
  opts: { typecast?: boolean } = {}
): PastePlan {
  const height = cells.length;
  const width = Math.max(0, ...cells.map((r) => r.length));
  const plan: PastePlan = {
    updates: [],
    creates: [],
    unreadable: 0,
    typecast: false,
    rows: 0,
    cols: 0,
  };
  if (height === 0 || width === 0) return plan;
  const selRows = target.bottom - target.top + 1;
  const selCols = target.right - target.left + 1;
  const tile =
    selRows % height === 0 && selCols % width === 0 && (selRows > height || selCols > width);
  const rows = tile ? selRows : height;
  const cols = Math.min(tile ? selCols : width, columns.length - target.left);
  plan.rows = rows;
  plan.cols = cols;
  for (let r = 0; r < rows; r++) {
    const row = target.top + r;
    const current = row < totalRows ? getRow(row) : undefined;
    const fields: Fields = {};
    for (let c = 0; c < cols; c++) {
      const field = columns[target.left + c];
      const cell = cells[r % height]?.[c % width] ?? { text: '' };
      if (!field || editorKind(field) === 'none') continue;
      const value = pastedValue(field, cell, opts.typecast);
      if (opts.typecast && missingOptions(field, cell).length > 0) plan.typecast = true;
      // Link names that match no record become new linked records, as in Airtable.
      if (isLink(field) && value !== null && value !== undefined) plan.typecast = true;
      if (value === undefined) {
        plan.unreadable += 1;
        continue;
      }
      if (row < totalRows && current && sameValue(value, current[field.id])) continue;
      if (row >= totalRows && sameValue(value, fieldDef(field).def.emptyValue)) continue;
      fields[field.id] = value;
    }
    if (row >= totalRows) plan.creates.push(fields);
    else if (Object.keys(fields).length > 0) plan.updates.push({ row, fields });
  }
  return plan;
}

/**
 * The fill handle and Ctrl/⌘ D: rows `[source.top, source.bottom]` repeat downwards
 * through row `to`, column by column (values are copied, not extended as a series).
 */
export function planFill(
  source: { top: number; bottom: number; left: number; right: number },
  to: number,
  columns: readonly FieldMeta[],
  getRow: (row: number) => Fields | undefined
): RowWrite[] {
  const height = source.bottom - source.top + 1;
  const writes: RowWrite[] = [];
  for (let row = source.bottom + 1; row <= to; row++) {
    const from = getRow(source.top + ((row - source.bottom - 1) % height));
    const current = getRow(row);
    if (!from || !current) continue;
    const fields: Fields = {};
    for (let col = source.left; col <= source.right; col++) {
      const field = columns[col];
      if (!field || editorKind(field) === 'none') continue;
      const value = from[field.id] ?? null;
      if (!sameValue(value, current[field.id])) fields[field.id] = value;
    }
    if (Object.keys(fields).length > 0) writes.push({ row, fields });
  }
  return writes;
}
