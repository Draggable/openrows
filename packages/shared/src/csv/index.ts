import { nextChoiceColor } from '../fields/choices.js';
import { type FieldTypeName, getFieldType } from '../fields/index.js';

/**
 * CSV for import and export: an RFC 4180 parser and writer, the formula-injection guard
 * for exported cells, and the column type inference of the import preview. Shared, so the
 * client's preview and the server's import read a file the same way.
 */

/** Biggest CSV file an import takes. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
/** Most rows one import takes. */
export const MAX_IMPORT_ROWS = 250_000;
/** Most columns one import takes (a table has at most 500 fields). */
export const MAX_IMPORT_COLUMNS = 500;

export class CsvParseError extends Error {
  constructor(
    message: string,
    /** 1-based line where the problem starts. */
    readonly line: number
  ) {
    super(`${message} (line ${line})`);
    this.name = 'CsvParseError';
  }
}

/** The likeliest delimiter of a file: the one of `, ; \t |` most used on its first line. */
export function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Parses CSV text into rows of cells (RFC 4180: quoted cells may hold delimiters, line breaks
 * and doubled quotes; CRLF, LF or CR line ends). A leading byte-order mark is dropped, and so
 * are blank lines. Throws `CsvParseError` for a quote that never closes or text after a closing
 * quote.
 */
export function parseCsv(text: string, opts: { delimiter?: string } = {}): string[][] {
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new Error(`parseCsv: invalid delimiter ${JSON.stringify(delimiter)}`);
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  const n = text.length;
  const endRow = () => {
    // A blank line is one empty cell: skip it.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i <= n) {
    if (i === n) {
      // End of input right after a delimiter or line break.
      if (row.length > 0) {
        row.push('');
        endRow();
      }
      break;
    }
    let cell: string;
    if (text[i] === '"') {
      const start = line;
      i++;
      let value = '';
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) throw new CsvParseError('A quoted cell never closes', start);
        const chunk = text.slice(i, q);
        for (const ch of chunk) if (ch === '\n') line++;
        value += chunk;
        if (text[q + 1] === '"') {
          value += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      const next = text[i];
      if (i < n && next !== delimiter && next !== '\n' && next !== '\r') {
        throw new CsvParseError('Text after a closing quote', line);
      }
      cell = value;
    } else {
      let j = i;
      while (j < n) {
        const ch = text[j];
        if (ch === delimiter || ch === '\n' || ch === '\r') break;
        j++;
      }
      cell = text.slice(i, j);
      i = j;
    }
    row.push(cell);
    if (i >= n) {
      endRow();
      break;
    }
    const ch = text[i];
    if (ch === delimiter) {
      i++;
      if (i === n) {
        row.push('');
        endRow();
        break;
      }
    } else {
      // A line break: CRLF, LF or CR.
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      endRow();
      if (i === n) break;
    }
  }
  return rows;
}

/** A cell as CSV: quoted when it holds a delimiter, quote or line break, or edge spaces. */
export function csvCell(value: string, delimiter = ','): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim()
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** One CSV line (with CRLF, as RFC 4180 has it). */
export function csvLine(cells: readonly string[], delimiter = ','): string {
  return `${cells.map((c) => csvCell(c, delimiter)).join(delimiter)}\r\n`;
}

/** A signed number as display text (`-12.5`, `-$1,234.00`, `-3%`): never a formula. */
const SIGNED_NUMBER = /^[-+][$€£¥]?\d[\d.,]*%?$/;

/**
 * Guards an exported cell against CSV formula injection (OWASP): a spreadsheet runs a cell that
 * starts with `= + - @` (or a tab or carriage return) as a formula, so such a cell gets a
 * leading `'`, which spreadsheets show as text. A signed number like `-12.5`, `-$3.00` or `-3%`
 * stays as it is.
 */
export function neutralizeCell(value: string): string {
  if (value === '' || !/^[=+\-@\t\r]/.test(value) || SIGNED_NUMBER.test(value)) return value;
  return `'${value}`;
}

/** An inferred field for a CSV column: a type and its options. */
export interface InferredField {
  type: FieldTypeName;
  options: Record<string, unknown>;
}

const BOOLEAN = /^(true|false|yes|no)$/i;
const NUMBER = /^-?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/;
const CURRENCY = /^-?\$(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/;
const PERCENT = /^-?\d+(\.\d+)?%$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL = /^https?:\/\/[^\s]+$/i;

/** Most choices a column gets as a single select; with more, it stays text. */
const MAX_INFERRED_CHOICES = 20;

function readable(type: FieldTypeName, values: readonly string[]): boolean {
  const def = getFieldType(type);
  const options = def.optionsSchema.parse({});
  return values.every((v) => def.coerce(v, options) !== null);
}

/**
 * The likeliest field type of a column from its cells (Airtable-like): checkbox (true/false,
 * yes/no), number, currency (`$`) or percent (with the precision of their longest fraction, up
 * to 8; thousands separators allowed), date, date and time,
 * email, URL, single select (a few values repeated often), long text (line breaks or long
 * values), otherwise single line text. Empty cells don't count.
 */
export function inferField(cells: readonly string[]): InferredField {
  const values = cells.map((c) => c.trim()).filter((c) => c !== '');
  const text: InferredField = { type: 'singleLineText', options: {} };
  if (values.length === 0) return text;
  const all = (re: RegExp) => values.every((v) => re.test(v));

  if (all(BOOLEAN)) return { type: 'checkbox', options: {} };
  const precision = () =>
    Math.min(8, Math.max(...values.map((v) => v.replace('%', '').split('.')[1]?.length ?? 0)));
  if (all(NUMBER)) return { type: 'number', options: { precision: precision() } };
  if (all(CURRENCY)) return { type: 'currency', options: { precision: precision() } };
  if (all(PERCENT)) return { type: 'percent', options: { precision: precision() } };
  if (all(ISO_DATE) && readable('date', values)) return { type: 'date', options: {} };
  if (all(US_DATE)) {
    if (readable('date', values)) return { type: 'date', options: {} };
    const european = { dateFormat: 'european' };
    if (values.every((v) => getFieldType('date').coerce(v, european) !== null)) {
      return { type: 'date', options: european };
    }
  }
  if (all(ISO_DATETIME) && readable('dateTime', values)) return { type: 'dateTime', options: {} };
  if (all(EMAIL)) return { type: 'email', options: {} };
  if (all(URL)) return { type: 'url', options: {} };
  if (cells.some((c) => c.includes('\n') || c.length > 255)) {
    return { type: 'longText', options: {} };
  }
  const distinct = [...new Set(values)];
  if (
    distinct.length <= MAX_INFERRED_CHOICES &&
    values.length >= 10 &&
    distinct.length * 3 <= values.length &&
    distinct.every((v) => v.length <= 60)
  ) {
    return {
      type: 'singleSelect',
      options: {
        choices: distinct.map((name, i) => ({
          id: `sel${String(i + 1).padStart(12, '0')}`,
          name,
          color: nextChoiceColor(i),
        })),
      },
    };
  }
  return text;
}

/**
 * Options for a new field of `type` holding `cells`: the inferred options when `type` is the
 * inferred type, choices from the distinct values for a type with choices (single and multiple
 * select), otherwise the type's defaults.
 */
export function optionsForColumn(
  type: FieldTypeName,
  cells: readonly string[],
  inferred: InferredField = inferField(cells)
): Record<string, unknown> {
  if (inferred.type === type) return inferred.options;
  const names = [...new Set(cells.map((c) => c.trim()).filter((c) => c !== ''))]
    .filter((c) => c.length <= 255)
    .slice(0, 1000);
  const withChoices = {
    choices: names.map((name, i) => ({
      id: `sel${String(i + 1).padStart(12, '0')}`,
      name,
      color: nextChoiceColor(i),
    })),
  };
  return getFieldType(type).optionsSchema.safeParse(withChoices).success ? withChoices : {};
}
