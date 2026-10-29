import {
  checkFormula,
  evaluateFormula,
  type FormulaError,
  type FormulaFieldInfo,
  type FormulaNode,
  type FormulaOptions,
  type FormulaResult,
  type FormulaType,
  type FormulaValue,
  fieldFormulaValue,
  formulaOptionsSchema,
  formulaResult,
  getFieldType,
  isFieldTypeName,
  parseFormula,
  parseStoredFormula,
  serializeFormula,
} from '@openrows/shared';
import { sql } from 'drizzle-orm';
import type { Transaction } from '../../db/index.js';
import type { FieldRow, TableRow } from '../../fields/service.js';
import { decodeLinks, linkSpecs } from '../../records/links.js';
import { qualified, readExpression } from '../columns.js';
import { linkReadExpr } from '../links.js';
import { formulaRefs } from './graph.js';

/**
 * Formula fields. A formula reads fields of its own record, so it recomputes for the
 * records whose referenced cells changed (the dependency graph's edges, graph.ts): the engine
 * reads those cells (one query per 5,000 records), evaluates the formula in JS with the shared
 * evaluator (a step and time budget per record) and writes the results that differ to the
 * field's `jsonb` column. 100k records compute in a few seconds (computed.test.ts).
 */

const CHUNK = 5000;

/** Parsed options of a field row (defaults when they don't parse). */
function optionsOf(row: FieldRow): unknown {
  if (!isFieldTypeName(row.type)) return {};
  const def = getFieldType(row.type);
  const parsed = def.optionsSchema.safeParse(row.config ?? {});
  return parsed.success ? parsed.data : def.optionsSchema.parse({});
}

/** The type a formula sees for a field: a formula's result type, else the registry's. */
function resultTypeOf(row: Pick<FieldRow, 'type' | 'config'>): FormulaType | undefined {
  if (row.type !== 'formula') return undefined;
  return formulaOptionsSchema.safeParse(row.config ?? {}).data?.resultType;
}

/** The table's fields as the parser and type checker see them. */
/** What the parser and type checker read of a field row. */
export type FormulaFieldRow = Pick<FieldRow, 'id' | 'name' | 'type' | 'config'>;

export function formulaFieldInfos(rows: readonly FormulaFieldRow[]): FormulaFieldInfo[] {
  return rows.map((r) => {
    const resultType = resultTypeOf(r);
    return { id: r.id, name: r.name, type: r.type, ...(resultType ? { resultType } : {}) };
  });
}

export type NormalizedFormula =
  | { ok: true; ast: FormulaNode; options: FormulaOptions }
  | { ok: false; errors: FormulaError[] };

/**
 * Reads the formula a client sent (fields by name as the user wrote it, or the stored form with
 * `{<field id>}`) against the table's live fields, type-checks it and gives the options to store:
 * the stored form, the result type and the referenced field ids.
 */
export function normalizeFormula(
  options: FormulaOptions,
  tableFields: readonly FormulaFieldRow[]
): NormalizedFormula {
  // A button's options carry the formula keys too; the rest (its label) is kept.
  const infos = formulaFieldInfos(tableFields);
  const text = options.formula;
  if (text.trim() === '') {
    return {
      ok: false,
      errors: [{ code: 'unexpectedEnd', message: 'Write a formula.', range: { start: 0, end: 0 } }],
    };
  }
  let parsed = parseFormula(text, { fields: infos });
  if (!parsed.ok) {
    // A client sending back the stored form (fields by id) gets the same formula.
    const stored = parseStoredFormula(text);
    const ids = new Set(infos.map((f) => f.id));
    if (stored.ok && formulaRefs(stored.ast).fieldIds.every((id) => ids.has(id))) parsed = stored;
  }
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };
  const checked = checkFormula(parsed.ast, { fields: infos });
  if (checked.errors.length) return { ok: false, errors: checked.errors };
  return {
    ok: true,
    ast: parsed.ast,
    options: {
      ...options,
      formula: serializeFormula(parsed.ast),
      resultType: checked.type,
      referencedFieldIds: formulaRefs(parsed.ast).fieldIds,
      isValid: true,
    },
  };
}

const toMs = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' || typeof v === 'number') {
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

/** The new values of a formula field for the records `ids` of its table. */
export async function computeFormulaValues(
  tx: Transaction,
  table: TableRow,
  ast: FormulaNode,
  deps: readonly FieldRow[],
  ids: readonly string[],
  now = Date.now()
): Promise<Map<string, FormulaResult | null>> {
  const links = await linkSpecs(
    tx,
    table,
    deps.filter((d) => d.type === 'link')
  );
  const readers = deps.flatMap((row) => {
    if (!isFieldTypeName(row.type)) return [];
    const def = getFieldType(row.type);
    const options = optionsOf(row);
    const resultType = resultTypeOf(row);
    const link = row.type === 'link' ? links.get(row.id)?.read : undefined;
    if (row.type === 'link' && !link) return [];
    const expr = link
      ? linkReadExpr(link)
      : readExpression({ type: row.type, dbColumn: row.dbColumn });
    const read = (raw: unknown): FormulaValue => {
      const value = def.fromStorage(link ? decodeLinks(link, raw) : raw, options);
      return fieldFormulaValue(
        { type: row.type, options, ...(resultType ? { resultType } : {}) },
        value
      );
    };
    return [{ id: row.id, expr, read }];
  });
  const created = readExpression({ type: 'createdTime', dbColumn: '' });
  const modified = readExpression({ type: 'lastModifiedTime', dbColumn: '' });
  const columns = readers.map((r, i) => sql`, ${r.expr} AS ${sql.identifier(`c${i}`)}`);
  const out = new Map<string, FormulaResult | null>();
  for (let start = 0; start < ids.length; start += CHUNK) {
    const batch = ids.slice(start, start + CHUNK);
    const { rows } = await tx.execute<Record<string, unknown>>(sql`
      SELECT r.id, ${created} AS created, ${modified} AS modified${sql.join(columns, sql``)}
        FROM ${qualified(table)} AS r WHERE r.id = ANY(${`{${batch.join(',')}}`}::uuid[])`);
    for (const row of rows) {
      const values = new Map<string, FormulaValue>();
      readers.forEach((r, i) => {
        values.set(r.id, r.read(row[`c${i}`]));
      });
      const result = evaluateFormula(ast, {
        field: (id) => values.get(id) ?? null,
        now,
        recordId: String(row['id']),
        createdTime: toMs(row['created']),
        lastModifiedTime: toMs(row['modified']),
      });
      out.set(String(row['id']), formulaResult(result));
    }
  }
  return out;
}
