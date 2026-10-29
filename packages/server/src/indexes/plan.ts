import { createHash } from 'node:crypto';
import {
  type FilterCondition,
  type FilterOperator,
  isFilterSubgroup,
  type SavedViewQuery,
  type Sort,
} from '@openrows/shared';
import type { QueryField } from '../data/query/compile.js';

/**
 * Which field indexes a table's saved views want (ADR-001). Pure: the index job
 * (sync.ts) compares the plan with the table's managed indexes and builds or drops the
 * difference. Each key is one of the expressions the query compiler (data/query/compile.ts)
 * sorts or filters by, so the planner can use the index; the integration test checks the
 * compiled queries' plans.
 */

/** One index key: a column, the expression over it, and its order (btree). */
export interface IndexKey {
  /** `f_<32 hex>`, or the system columns `id`, `created_at`, `updated_at`. */
  column: string;
  /** `lower(col)` for text, `coalesce(col, false)` for checkboxes, else the column itself. */
  fn: 'none' | 'lower' | 'coalesce_false';
  /** `DESC NULLS LAST` (the compiler's descending order) instead of `ASC NULLS FIRST`. */
  desc: boolean;
}

export interface IndexSpec {
  /** `i_<24 hex>`: a hash of the definition, so the same index always has the same name. */
  name: string;
  method: 'btree' | 'trgm';
  keys: IndexKey[];
  /** A sort or group key (with the id), a filtered field, or a view's whole order. */
  kind: 'sort' | 'filter' | 'composite';
  /** How many saved views it serves. */
  views: number;
}

export interface IndexLimits {
  /** Single-field indexes per table (sorts, groups and filters), the most used first. */
  fields: number;
  /** Keyset composites (group and sort keys…, id) per table, for the most used orders. */
  composites: number;
}

/** Per-table caps: every index slows writes a little and costs disk. */
export const INDEX_LIMITS: IndexLimits = { fields: 8, composites: 1 };

/** Most keys one index takes (the DDL function's limit). */
const MAX_KEYS = 8;

/** ADR-001: fields are indexed once their table passes 10,000 rows. */
export const INDEX_MIN_ROWS = 10_000;

/**
 * Text types whose values can pass btree's entry limit (about 2.7 kB): a build would fail on the
 * first long value. They still get trigram indexes (GIN has no such limit).
 */
const UNBOUNDED_TEXT = new Set<string>(['longText']);

const SYSTEM_SORT_COLUMNS = new Set(['created_at', 'updated_at']);
const ID_KEY: IndexKey = { column: 'id', fn: 'none', desc: false };

/** The physical column of a plain field, or null for links, junctions and odd names. */
function columnOf(f: QueryField): string | null {
  if (f.link) return null;
  const storage = f.def.storage;
  if (storage.kind === 'system') {
    return SYSTEM_SORT_COLUMNS.has(storage.column) ? storage.column : null;
  }
  if (storage.kind === 'link') return null;
  return /^f_[0-9a-f]{32}$/.test(f.dbColumn) ? f.dbColumn : null;
}

/**
 * The index expression of a field's sort key, or null when the compiler sorts it by something an
 * index can't hold: a subquery (people's names), the options' order (selects), a lookup's or
 * rollup's derived text, a barcode's JSON text.
 */
export function sortKeyOf(f: QueryField): Omit<IndexKey, 'desc'> | null {
  const column = columnOf(f);
  if (column === null) return null;
  const storage = f.def.storage;
  if (storage.kind === 'column' && (storage.items === 'userIds' || storage.textKey)) return null;
  switch (f.def.sort) {
    case 'text':
      return storage.sqlType === 'text' && !UNBOUNDED_TEXT.has(f.type)
        ? { column, fn: 'lower' }
        : null;
    case 'boolean':
      return storage.sqlType === 'boolean' ? { column, fn: 'coalesce_false' } : null;
    case 'number':
    case 'chronological':
      return storage.sqlType === 'jsonb' || storage.sqlType === 'text[]'
        ? null
        : { column, fn: 'none' };
    default:
      return null;
  }
}

const CHOICE_MATCH: readonly FilterOperator[] = ['is', 'isAnyOf'];

/**
 * The index a filter condition can use: trigram for "contains" on text (ILIKE), the sort
 * index's `lower(col)` for text equality, the column for numbers, dates and a single select's
 * choice. Negations, emptiness checks and checkboxes match too many rows to gain from one.
 */
export function filterIndexOf(
  f: QueryField,
  operator: FilterOperator
): { method: IndexSpec['method']; key: Omit<IndexKey, 'desc'> } | null {
  const column = columnOf(f);
  if (column === null) return null;
  if (operator === 'isEmpty' || operator === 'isNotEmpty') return null;
  const storage = f.def.storage;
  if (storage.kind === 'column' && (storage.items === 'userIds' || storage.textKey)) return null;
  if (f.def.sort === 'choiceOrder') {
    return storage.sqlType === 'text' && CHOICE_MATCH.includes(operator)
      ? { method: 'btree', key: { column, fn: 'none' } }
      : null;
  }
  if (f.def.sort === 'text' && storage.sqlType === 'text') {
    if (operator === 'contains') return { method: 'trgm', key: { column, fn: 'none' } };
    return operator === 'is' && !UNBOUNDED_TEXT.has(f.type)
      ? { method: 'btree', key: { column, fn: 'lower' } }
      : null;
  }
  if (f.def.sort === 'number' || f.def.sort === 'chronological') {
    if (storage.sqlType === 'jsonb' || storage.sqlType === 'text[]') return null;
    return operator === '!=' ? null : { method: 'btree', key: { column, fn: 'none' } };
  }
  return null;
}

/** The index name of a definition: stable across runs and workers. */
export function indexName(method: IndexSpec['method'], keys: readonly IndexKey[]): string {
  const canonical = JSON.stringify({
    method,
    keys: keys.map((k) => [k.column, k.fn, method === 'btree' && k.desc]),
  });
  return `i_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

function conditionsOf(query: SavedViewQuery): FilterCondition[] {
  return (query.filter?.conditions ?? []).flatMap((c) =>
    isFilterSubgroup(c) ? c.conditions : [c]
  );
}

interface Candidate {
  spec: Omit<IndexSpec, 'views'>;
  views: Set<number>;
  first: number;
}

/**
 * The indexes a table's saved views want, at most `limits` of them: single-field indexes for the
 * fields they sort, group or filter by (sort and group keys with the id, so a one-key order is a
 * keyset scan), the most used first, then a keyset composite (group keys, sort keys…, id) for
 * the most common whole order. `queries` are the views' saved queries, pruned to the live
 * fields, in sidebar order (which breaks ties: the first view is the one a table opens on).
 */
export function planIndexes(
  fields: readonly QueryField[],
  queries: readonly SavedViewQuery[],
  limits: IndexLimits = INDEX_LIMITS
): IndexSpec[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const singles = new Map<string, Candidate>();
  const composites = new Map<string, Candidate>();
  const add = (
    into: Map<string, Candidate>,
    kind: IndexSpec['kind'],
    method: IndexSpec['method'],
    keys: IndexKey[],
    view: number
  ) => {
    const name = indexName(method, keys);
    const seen = into.get(name);
    if (seen) seen.views.add(view);
    else
      into.set(name, { spec: { name, method, keys, kind }, views: new Set([view]), first: view });
  };

  queries.forEach((query, view) => {
    const order: Sort[] = [...(query.groupBy ?? []), ...(query.sorts ?? [])];
    for (const s of order) {
      const f = byId.get(s.fieldId);
      const key = f && sortKeyOf(f);
      if (key) add(singles, 'sort', 'btree', [{ ...key, desc: false }, ID_KEY], view);
    }
    for (const c of conditionsOf(query)) {
      const f = byId.get(c.fieldId);
      const index = f && filterIndexOf(f, c.operator);
      if (!index) continue;
      // A sort index on the same expression already serves equality and ranges.
      const sortName = indexName('btree', [{ ...index.key, desc: false }, ID_KEY]);
      if (index.method === 'btree' && singles.has(sortName)) {
        singles.get(sortName)?.views.add(view);
        continue;
      }
      add(singles, 'filter', index.method, [{ ...index.key, desc: false }], view);
    }
    // The view's whole order: the indexable prefix of its keys, then the id when all of them are.
    const keys: IndexKey[] = [];
    let whole = true;
    for (const s of order) {
      const f = byId.get(s.fieldId);
      const key = f && sortKeyOf(f);
      if (!key) {
        whole = false;
        break;
      }
      keys.push({ ...key, desc: s.direction === 'desc' });
    }
    if (keys.length === 0) return;
    const capped = keys.slice(0, MAX_KEYS);
    if (whole && capped.length < MAX_KEYS) capped.push(ID_KEY);
    add(composites, 'composite', 'btree', capped, view);
  });

  // A filter-only btree whose sort twin was added by a later view is redundant.
  for (const [name, c] of singles) {
    if (c.spec.kind !== 'filter' || c.spec.method !== 'btree') continue;
    const [key] = c.spec.keys;
    const twin = key && singles.get(indexName('btree', [key, ID_KEY]));
    if (twin) {
      for (const v of c.views) twin.views.add(v);
      singles.delete(name);
    }
  }

  const rank = (a: Candidate, b: Candidate) =>
    b.views.size - a.views.size ||
    Number(a.spec.kind === 'filter') - Number(b.spec.kind === 'filter') ||
    a.first - b.first;
  const chosen = [...singles.values()].sort(rank).slice(0, limits.fields);
  const names = new Set(chosen.map((c) => c.spec.name));
  const extra = [...composites.values()]
    .filter((c) => !names.has(c.spec.name))
    .sort(rank)
    .slice(0, limits.composites);
  return [...chosen, ...extra].map((c) => ({ ...c.spec, views: c.views.size }));
}
