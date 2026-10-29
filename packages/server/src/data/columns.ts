import {
  type FieldStorage,
  getFieldType,
  isFieldTypeName,
  type SqlColumnType,
} from '@openrows/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { Transaction } from '../db/index.js';
import { type LinkRead, linkReadExpr } from './links.js';

/** Where a table's records live (from RLS-protected metadata, ADR-001 "TableHandle"). */
export interface TableLocation {
  id: string;
  dbSchema: string;
  dbTable: string;
}

export const qualified = (t: TableLocation) =>
  sql`${sql.identifier(t.dbSchema)}.${sql.identifier(t.dbTable)}`;

/** The registry's storage for a stored field type name. */
export function storageOf(type: string): FieldStorage {
  if (!isFieldTypeName(type)) throw new Error(`unknown field type ${type}`);
  return getFieldType(type).storage;
}

/**
 * SQL reading a field's raw value, in the form the registry's `fromStorage` expects. Dates are
 * read as text, because node-postgres turns `date` into a local-midnight `Date`. Link fields
 * (`link`, from records/links.ts) read their junction, aggregated; the outer row is `r`.
 */
export function readExpression(field: { type: string; dbColumn: string; link?: LinkRead }): SQL {
  const storage = storageOf(field.type);
  if (storage.kind === 'link') {
    if (!field.link) throw new Error(`link field ${field.dbColumn} read without its location`);
    return linkReadExpr(field.link);
  }
  const column = sql.identifier(storage.kind === 'system' ? storage.column : field.dbColumn);
  return storage.sqlType === 'date' ? sql`${column}::text` : sql`${column}`;
}

/**
 * SQL turning the JSON value at `json` (a jsonb expression, `null` or missing for empty) into a
 * value of `type`.
 */
export function castFromJson(json: SQL, type: SqlColumnType): SQL {
  switch (type) {
    case 'text[]':
      return sql`CASE WHEN jsonb_typeof(${json}) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(${json})) END`;
    case 'jsonb':
      return sql`nullif(${json}, 'null'::jsonb)`;
    default:
      // `type` is one of the SqlColumnType literals, never input. `#>> '{}'` unwraps a scalar.
      return sql`(${json} #>> '{}')::${sql.raw(type)}`;
  }
}

const WRITE_BATCH = 5000;

/** Writes storage values into `column` by record id, in batches. */
export async function writeColumn(
  tx: Transaction,
  table: TableLocation,
  column: string,
  type: SqlColumnType,
  values: { id: string; v: unknown }[]
): Promise<void> {
  for (let i = 0; i < values.length; i += WRITE_BATCH) {
    const batch = JSON.stringify(values.slice(i, i + WRITE_BATCH));
    await tx.execute(sql`
      UPDATE ${qualified(table)} AS r SET ${sql.identifier(column)} = s.val
        FROM (SELECT (e->>'id')::uuid AS id, ${castFromJson(sql`e->'v'`, type)} AS val
                FROM jsonb_array_elements(${batch}::jsonb) AS e) AS s
       WHERE r.id = s.id`);
  }
}
