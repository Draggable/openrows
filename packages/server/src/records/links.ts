import {
  getFieldType,
  isRecordId,
  type LinkOptions,
  type LinkValue,
  linkOptionsSchema,
} from '@openrows/shared';
import { and, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { physicalName } from '../data/ddl.js';
import {
  junctionOf,
  type LinkedPrimary,
  type LinkRead,
  linkReadExpr,
  otherPosition,
  otherSide,
  primaryText,
  selfPosition,
  targetOf,
} from '../data/links.js';
import type { OutboxEvent } from '../data/outbox.js';
import { fields, type Transaction, tables } from '../db/index.js';
import type { FieldRow, TableRow } from '../fields/service.js';
import { fieldType } from '../fields/service.js';

/**
 * Links (ADR-001): one junction per link field pair, `l_<owner field hex>`, read and
 * written through the RecordService. Everything here runs in the request's authorized
 * transaction; the linked table is always a table of the same base, loaded from RLS-protected
 * metadata, so links can't reach another base or workspace.
 */

/** A link field as the RecordService uses it. */
export interface LinkSpec {
  field: FieldRow;
  options: LinkOptions;
  /** The junction as this field's table sees it. */
  read: LinkRead;
  /** The linked table (in the same base). */
  target: TableRow;
  /** The live inverse field in the linked table, if any (self-links have none). */
  inverse: FieldRow | null;
  /** The junction as the inverse field sees it (for the other side's events). */
  mirror: LinkRead | null;
}

const isLink = (row: FieldRow) => row.type === 'link';

function primaryOf(row: FieldRow | undefined): LinkedPrimary | null {
  if (!row) return null;
  const def = getFieldType(fieldType(row));
  return {
    type: row.type,
    dbColumn: row.dbColumn,
    def,
    options: def.optionsSchema.parse(row.config ?? {}),
  };
}

/** The junction column of a link field's own table: `from_id` when it owns the junction. */
export const selfColumn = (row: FieldRow): 'from_id' | 'to_id' =>
  row.dbColumn === physicalName.junction(row.id) ? 'from_id' : 'to_id';

/**
 * The link specs of `rows` (fields of `table`) by field id: the linked tables, their primary
 * fields and the inverse fields, in three queries whatever the number of link fields.
 */
export async function linkSpecs(
  tx: Transaction,
  table: TableRow,
  rows: readonly FieldRow[]
): Promise<Map<string, LinkSpec>> {
  const links = rows.filter(isLink);
  const out = new Map<string, LinkSpec>();
  if (!links.length) return out;
  const parsed = links.map((row) => ({ row, options: linkOptionsSchema.parse(row.config ?? {}) }));
  const targetIds = [
    ...new Set(parsed.flatMap((p) => (p.options.linkedTableId ? [p.options.linkedTableId] : []))),
  ];
  if (!targetIds.length) return out;
  const targets = new Map(
    (
      await tx
        .select()
        .from(tables)
        .where(and(inArray(tables.id, targetIds), eq(tables.baseId, table.baseId)))
    ).map((t) => [t.id, t])
  );
  const inverseIds = parsed.flatMap((p) =>
    p.options.inverseLinkFieldId ? [p.options.inverseLinkFieldId] : []
  );
  const related = await tx
    .select()
    .from(fields)
    .where(
      and(
        isNull(fields.deletedAt),
        sql`(${fields.isPrimary} AND ${inArray(fields.tableId, [...targetIds, table.id])})
          OR ${inverseIds.length ? inArray(fields.id, inverseIds) : sql`false`}`
      )
    );
  const primaries = new Map(related.filter((f) => f.isPrimary).map((f) => [f.tableId, f]));
  const byId = new Map(related.map((f) => [f.id, f]));
  for (const { row, options } of parsed) {
    const target = options.linkedTableId ? targets.get(options.linkedTableId) : undefined;
    if (!target) continue;
    const self = selfColumn(row);
    const read: LinkRead = {
      schema: table.dbSchema,
      junction: row.dbColumn,
      self,
      target,
      primary: primaryOf(primaries.get(target.id)),
    };
    const inverse = options.inverseLinkFieldId
      ? (byId.get(options.inverseLinkFieldId) ?? null)
      : null;
    const mirror: LinkRead | null = inverse
      ? {
          schema: table.dbSchema,
          junction: row.dbColumn,
          self: self === 'from_id' ? 'to_id' : 'from_id',
          target: table,
          primary: primaryOf(primaries.get(table.id)),
        }
      : null;
    out.set(row.id, { field: row, options, read, target, inverse, mirror });
  }
  return out;
}

/**
 * Turns a link cell as SQL reads it (`[{ id, v }]`, `v` the primary field's raw value) into the
 * API's `[{ id, name }]`, the name being the primary value's display text.
 */
export function decodeLinks(read: LinkRead, raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const p = read.primary;
  return raw.map((item: { id: string; v: unknown }) => ({
    id: item.id,
    name: p ? p.def.format(p.def.fromStorage(item.v, p.options), p.options) : '',
  }));
}

/** A JSON array parameter as `text[]` (any string content is safe). */
const textArray = (items: readonly string[]) =>
  sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(items)}::jsonb))`;
const uuidArray = (items: readonly string[]) =>
  sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(items)}::jsonb)::uuid)`;

// ---- names -------------------------------------------------------------------------------

/** One item of a link cell's input: a record id, or text naming a record by primary value. */
type LinkToken = { id: string } | { name: string };

/**
 * Reads a link cell's raw input into tokens (paste, import, typecast): record ids, `{ id }`
 * objects, and text, which names records by their primary field. `null` when the input isn't
 * link input at all (it then goes to `coerce` as it is, and fails there if it's junk).
 */
export function linkTokens(raw: unknown): LinkToken[] | null {
  const items = Array.isArray(raw) ? raw : [raw];
  const tokens: LinkToken[] = [];
  for (const item of items) {
    if (isRecordId(item)) tokens.push({ id: item.toLowerCase() });
    else if (typeof item === 'object' && item !== null && 'id' in item && isRecordId(item.id))
      tokens.push({ id: item.id.toLowerCase() });
    else if (typeof item === 'string' && item.trim()) tokens.push({ name: item.trim() });
    else if (typeof item === 'number' && Number.isFinite(item)) tokens.push({ name: String(item) });
    else if (item !== null && item !== undefined && item !== '') return null;
  }
  return tokens;
}

/** The names a token may stand for: the whole text, else its comma-separated parts. */
export function nameCandidates(name: string): string[] {
  const parts = name
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 ? [name, ...parts] : [name];
}

/**
 * Live records of the linked table whose primary text equals one of `names` (ignoring case),
 * by lower-cased name; the oldest record wins a tie, as in Airtable.
 */
export async function matchNames(
  tx: Transaction,
  spec: LinkSpec,
  names: readonly string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!names.length || !spec.read.primary) return out;
  const lower = [...new Set(names.map((n) => n.toLowerCase()))];
  const { rows } = await tx.execute<{ id: string; k: string }>(sql`
    SELECT t.id, lower(${primaryText(spec.read)}) AS k FROM ${targetOf(spec.read)} AS t
     WHERE t.deleted_at IS NULL AND lower(${primaryText(spec.read)}) = ANY(${textArray(lower)})
     ORDER BY t.id`);
  for (const r of rows) if (!out.has(r.k)) out.set(r.k, r.id);
  return out;
}

/**
 * Resolves tokens to record ids with `matched` (lower-cased name → id). Text matches as a whole
 * first, then by its comma-separated parts. Answers the ids and the names nothing matched.
 */
export function resolveTokens(
  tokens: readonly LinkToken[],
  matched: ReadonlyMap<string, string>
): { ids: string[]; unmatched: string[] } {
  const ids: string[] = [];
  const unmatched: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const token of tokens) {
    if ('id' in token) {
      add(token.id);
      continue;
    }
    const whole = matched.get(token.name.toLowerCase());
    if (whole) {
      add(whole);
      continue;
    }
    const [, ...parts] = nameCandidates(token.name);
    for (const part of parts.length ? parts : [token.name]) {
      const id = matched.get(part.toLowerCase());
      if (id) add(id);
      else if (!unmatched.some((u) => u.toLowerCase() === part.toLowerCase())) unmatched.push(part);
    }
  }
  return { ids, unmatched };
}

// ---- checks ------------------------------------------------------------------------------

/** Of `ids`, the ones that aren't live records of the linked table. */
export async function missingTargets(
  tx: Transaction,
  spec: LinkSpec,
  ids: readonly string[]
): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT t.id FROM ${targetOf(spec.read)} AS t
     WHERE t.id = ANY(${uuidArray(ids)}) AND t.deleted_at IS NULL`);
  const found = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !found.has(id));
}

/** Of `ids` (live records of the linked table), the ones the `where` (alias `r`) leaves out. */
export async function outsideView(
  tx: Transaction,
  spec: LinkSpec,
  ids: readonly string[],
  where: SQL
): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT r.id FROM ${targetOf(spec.read)} AS r WHERE r.id = ANY(${uuidArray(ids)}) AND ${where}`);
  const inside = new Set(rows.map((r) => r.id));
  return ids.filter((id) => !inside.has(id));
}

// ---- writes ------------------------------------------------------------------------------

/** One record's new links in one link field, in order. */
export interface LinkWrite {
  recordId: string;
  ids: string[];
}

/**
 * Sets the links of records in one link field: links to live records that aren't listed any
 * more are removed (links to records in the trash stay, so restoring them brings the link back),
 * listed ones are added at the end of the other side's order or re-ordered on this side. Both
 * sides are the same junction rows, so they change together. Answers the records on the other
 * side whose links changed.
 */
export async function writeLinks(
  tx: Transaction,
  spec: LinkSpec,
  writes: readonly LinkWrite[]
): Promise<string[]> {
  if (!writes.length) return [];
  const r = spec.read;
  const j = junctionOf(r);
  const self = sql.identifier(r.self);
  const other = sql.identifier(otherSide(r));
  const selfPos = sql.identifier(selfPosition(r));
  const otherPos = sql.identifier(otherPosition(r));
  const json = JSON.stringify(writes.map((w) => ({ id: w.recordId, ids: w.ids })));
  const source = sql`(SELECT (e->>'id')::uuid AS rid, (x.v #>> '{}')::uuid AS oid, x.n AS ord
      FROM jsonb_array_elements(${json}::jsonb) AS e,
           jsonb_array_elements(e->'ids') WITH ORDINALITY AS x(v, n))`;
  const recordIds = uuidArray(writes.map((w) => w.recordId));

  const removed = await tx.execute<{ oid: string }>(sql`
    DELETE FROM ${j} AS j USING ${targetOf(r)} AS t
     WHERE j.${self} = ANY(${recordIds}) AND t.id = j.${other} AND t.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ${source} AS s WHERE s.rid = j.${self} AND s.oid = j.${other})
    RETURNING j.${other} AS oid`);
  // `xmax = 0` tells a fresh insert from a conflict update (a re-ordered link).
  const added = await tx.execute<{ oid: string; inserted: boolean }>(sql`
    INSERT INTO ${j} AS j (${self}, ${other}, ${selfPos}, ${otherPos})
    SELECT s.rid, s.oid, s.ord,
           coalesce((SELECT max(k.${otherPos}) FROM ${j} AS k WHERE k.${other} = s.oid), 0) + 1
      FROM ${source} AS s
     ORDER BY s.rid, s.ord
    ON CONFLICT (from_id, to_id) DO UPDATE SET ${selfPos} = EXCLUDED.${selfPos}
    RETURNING j.${other} AS oid, (xmax = 0) AS inserted`);
  const changed = new Set<string>(removed.rows.map((x) => x.oid));
  for (const row of added.rows) if (row.inserted) changed.add(row.oid);
  return [...changed];
}

/** Live records on the other side linked to any of `ids` (for events when those change). */
export async function linkedRecords(
  tx: Transaction,
  spec: LinkSpec,
  ids: readonly string[]
): Promise<string[]> {
  if (!ids.length) return [];
  const r = spec.read;
  const { rows } = await tx.execute<{ oid: string }>(sql`
    SELECT DISTINCT j.${sql.identifier(otherSide(r))} AS oid
      FROM ${junctionOf(r)} AS j JOIN ${targetOf(r)} AS t ON t.id = j.${sql.identifier(otherSide(r))}
     WHERE j.${sql.identifier(r.self)} = ANY(${uuidArray(ids)}) AND t.deleted_at IS NULL`);
  return rows.map((x) => x.oid);
}

/**
 * `record.updated` events for records on the other side whose inverse cell changed, with the
 * cell as it is now (ADR-003: both sides of a link change get an event). Their version doesn't
 * change: the junction row is the change, and bumping it would lock rows of another table.
 */
export async function inverseEvents(
  tx: Transaction,
  spec: LinkSpec,
  recordIds: readonly string[],
  base: { workspaceId: string; actorId: string | null; clientOpId?: string }
): Promise<OutboxEvent[]> {
  const { inverse, mirror } = spec;
  if (!inverse || !mirror || !recordIds.length) return [];
  const { rows } = await tx.execute<{ id: string; version: number; v: unknown }>(sql`
    SELECT r.id, r.version, ${linkReadExpr(mirror)} AS v FROM ${targetOf(spec.read)} AS r
     WHERE r.id = ANY(${uuidArray(recordIds)}) AND r.deleted_at IS NULL ORDER BY r.id`);
  const def = getFieldType('link');
  return rows.map((row) => ({
    workspaceId: base.workspaceId,
    baseId: spec.target.baseId,
    tableId: spec.target.id,
    kind: 'record.updated' as const,
    payload: {
      recordId: row.id,
      version: row.version,
      fieldIds: [inverse.id],
      cells: { [inverse.id]: def.fromStorage(decodeLinks(mirror, row.v), {}) as LinkValue | null },
    },
    actorId: base.actorId,
    clientOpId: base.clientOpId,
  }));
}
