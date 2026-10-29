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
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  optionsForColumn,
  parseCsv,
} from '@openrows/shared';

/** Where a CSV column goes. */
export type ColumnTarget =
  | { kind: 'skip' }
  | { kind: 'field'; fieldId: string }
  | { kind: 'new'; name: string; type: FieldTypeName };

/** One CSV column in the import dialog: its name, first values, inferred type and target. */
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

/** Parses a picked file's text (any of the delimiters `parseCsv` detects). */
export function readCsv(text: string, bytes: number): ReadResult {
  if (bytes > MAX_IMPORT_BYTES) return { ok: false, error: 'The file is bigger than 50 MB.' };
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
 * The import request for the file and the mapping. `typecast` ("Add missing options", for
 * roles that may change fields) makes the server add the select options the file names.
 */
export function importBody(
  csv: string,
  rows: readonly string[][],
  hasHeader: boolean,
  plans: readonly ColumnPlan[],
  typecast = false
): CreateImportInput {
  const data = dataRows(rows, hasHeader);
  return {
    csv,
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
