import {
  type CreateImportInput,
  CsvParseError,
  FIELD_TYPE_NAMES,
  type FieldMeta,
  type FieldTypeName,
  getFieldType,
  type ImportColumn,
  type InferredField,
  inferField,
  isZipFile,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  optionsForColumn,
  parseCsv,
  readXlsx,
  XLSX_MEDIA_TYPE,
  XlsxReadError,
} from '@openrows/shared';

/** What the import file pickers take: CSV (and TSV) files and Excel workbooks. */
export const IMPORT_FILE_ACCEPT = [
  '.csv',
  '.tsv',
  '.txt',
  '.xlsx',
  'text/csv',
  'text/tab-separated-values',
  XLSX_MEDIA_TYPE,
].join(',');

/** Where a column of the file goes. */
export type ColumnTarget =
  | { kind: 'skip' }
  | { kind: 'field'; fieldId: string }
  | { kind: 'new'; name: string; type: FieldTypeName };

/** One column in the import dialog: its name, first values, inferred type and target. */
export interface ColumnPlan {
  index: number;
  header: string;
  sample: string[];
  inferred: InferredField;
  target: ColumnTarget;
}

/** Rows shown in the preview. */
export const PREVIEW_ROWS = 5;

/** A file read for import, or why it can't be. */
export type ReadResult = { ok: true; rows: string[][] } | { ok: false; error: string };

/** The picked file as the import sends it: CSV text, or a workbook and the sheet chosen. */
export type ImportSource =
  | { kind: 'csv'; text: string }
  | { kind: 'xlsx'; bytes: Uint8Array; sheets: string[]; sheet: string };

/** A picked file read for import: its rows and how to send it, or why it can't be. */
export type FileRead =
  | { ok: true; rows: string[][]; source: ImportSource }
  | { ok: false; error: string };

const TOO_BIG = 'The file is bigger than 50 MB.';

/** Parses a picked file's text (any of the delimiters `parseCsv` detects). */
export function readCsv(text: string, bytes: number): ReadResult {
  if (bytes > MAX_IMPORT_BYTES) return { ok: false, error: TOO_BIG };
  try {
    const rows = parseCsv(text);
    if (rows.length === 0) return { ok: false, error: 'The file is empty.' };
    if (rows.length > MAX_IMPORT_ROWS + 1) {
      return {
        ok: false,
        error: `The file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows.`,
      };
    }
    return { ok: true, rows };
  } catch (err) {
    if (err instanceof CsvParseError)
      return { ok: false, error: `Not a valid CSV: ${err.message}` };
    throw err;
  }
}

/**
 * Reads one sheet of a workbook (`sheet`, else the first) with the reader the server uses. A
 * workbook of several sheets reads even when the sheet is empty (rows `[]`), so another one can
 * be chosen; a workbook's only sheet has to have rows.
 */
export function readWorkbook(bytes: Uint8Array, sheet?: string): FileRead {
  if (bytes.length > MAX_IMPORT_BYTES) return { ok: false, error: TOO_BIG };
  try {
    const read = readXlsx(bytes, { sheet });
    if (read.rows.length === 0 && read.sheets.length === 1) {
      return { ok: false, error: 'The workbook is empty.' };
    }
    return {
      ok: true,
      rows: read.rows,
      source: { kind: 'xlsx', bytes, sheets: read.sheets, sheet: read.sheet },
    };
  } catch (err) {
    if (err instanceof XlsxReadError) return { ok: false, error: err.message };
    throw err;
  }
}

/** An Excel file by its name or type (.xls too: the reader explains it isn't supported). */
export function isWorkbookFile(file: { name: string; type: string }): boolean {
  return /\.xlsx?$/i.test(file.name) || file.type === XLSX_MEDIA_TYPE;
}

/**
 * Reads a picked file: a workbook's first sheet (by its name or type, or a ZIP archive whatever
 * its name), else CSV text.
 */
export async function readImportFile(file: File): Promise<FileRead> {
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: TOO_BIG };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isWorkbookFile(file) || isZipFile(bytes)) return readWorkbook(bytes);
  const text = new TextDecoder().decode(bytes);
  const read = readCsv(text, file.size);
  return read.ok ? { ...read, source: { kind: 'csv', text } } : read;
}

/** Bytes as base64, in slices (a 50 MB file is too big for one `fromCharCode` call). */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(parts.join(''));
}

/** Fields an import can write (not computed or read-only). */
export function writableFields(fields: readonly FieldMeta[]): FieldMeta[] {
  return fields.filter((f) => {
    const def = getFieldType(f.type);
    return !def.readOnly && !def.computed;
  });
}

/** Field types a new import column can have. */
export function importableTypes(): FieldTypeName[] {
  return FIELD_TYPE_NAMES.filter((t) => {
    const def = getFieldType(t);
    return !def.readOnly && !def.computed;
  });
}

/** The data rows (without the header row when there is one). */
export function dataRows(rows: readonly string[][], hasHeader: boolean): readonly string[][] {
  return hasHeader ? rows.slice(1) : rows;
}

/**
 * The first plan of every column: a column whose name matches a writable field goes there; the
 * others become new fields of the inferred type when the role may create fields, or are skipped.
 */
export function planColumns(
  rows: readonly string[][],
  hasHeader: boolean,
  fields: readonly FieldMeta[],
  canCreateFields: boolean
): ColumnPlan[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const data = dataRows(rows, hasHeader);
  const writable = writableFields(fields);
  const taken = new Set(fields.map((f) => f.name.toLowerCase()));
  const mapped = new Set<string>();
  return Array.from({ length: width }, (_, index) => {
    const header = (hasHeader ? rows[0]?.[index]?.trim() : '') || `Field ${index + 1}`;
    const values = data.map((r) => r[index] ?? '');
    const inferred = inferField(values);
    const match = writable.find(
      (f) => f.name.toLowerCase() === header.toLowerCase() && !mapped.has(f.id)
    );
    let target: ColumnTarget = { kind: 'skip' };
    if (match) {
      mapped.add(match.id);
      target = { kind: 'field', fieldId: match.id };
    } else if (canCreateFields) {
      let name = header;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${header} ${n}`;
      taken.add(name.toLowerCase());
      target = { kind: 'new', name, type: inferred.type };
    }
    return { index, header, sample: values.slice(0, PREVIEW_ROWS), inferred, target };
  });
}

/** Problems that keep the mapping from being imported, by column index (`-1`: the whole). */
export function mappingErrors(plans: readonly ColumnPlan[], fields: readonly FieldMeta[]) {
  const errors = new Map<number, string>();
  const names = new Set(fields.map((f) => f.name.toLowerCase()));
  const fieldUse = new Set<string>();
  for (const p of plans) {
    if (p.target.kind === 'new') {
      const name = p.target.name.trim().toLowerCase();
      if (!name) errors.set(p.index, 'Name the new field.');
      else if (names.has(name)) errors.set(p.index, 'A field with this name exists.');
      names.add(name);
    } else if (p.target.kind === 'field') {
      if (fieldUse.has(p.target.fieldId)) errors.set(p.index, 'Another column goes there.');
      fieldUse.add(p.target.fieldId);
    }
  }
  if (plans.every((p) => p.target.kind === 'skip')) errors.set(-1, 'Map at least one column.');
  return errors;
}

/**
 * The import request for the file and the mapping: the CSV text, or the workbook (base64) and
 * its chosen sheet. `typecast` ("Add missing options", for roles that may change fields) makes
 * the server add the select options the file names.
 */
export function importBody(
  source: ImportSource,
  rows: readonly string[][],
  hasHeader: boolean,
  plans: readonly ColumnPlan[],
  typecast = false
): CreateImportInput {
  const data = dataRows(rows, hasHeader);
  return {
    ...(source.kind === 'csv'
      ? { csv: source.text }
      : { xlsx: toBase64(source.bytes), sheet: source.sheet }),
    hasHeader,
    ...(typecast ? { typecast: true } : {}),
    columns: plans.flatMap((p): ImportColumn[] => {
      if (p.target.kind === 'field') return [{ index: p.index, fieldId: p.target.fieldId }];
      if (p.target.kind === 'skip') return [];
      const values = data.map((r) => r[p.index] ?? '');
      return [
        {
          index: p.index,
          newField: {
            name: p.target.name.trim(),
            type: p.target.type,
            options: optionsForColumn(p.target.type, values, p.inferred),
          },
        },
      ];
    }),
  };
}
