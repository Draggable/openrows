import {
  computedSourceOf,
  type FieldTypeDef,
  type FormulaOptions,
  formulaOptionsSchema,
  getFieldType,
  isFieldTypeName,
  linkOptionsSchema,
  lookupValue,
  type RollupOptions,
  rollupItems,
  rollupValue,
} from '@openrows/shared';
import { and, eq, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { aiOptionsOf, emitAiStatus, markAiPending, wakeAiWorker } from '../../ai/fields/repo.js';
import { fields, type Transaction, tables } from '../../db/index.js';
import type { FieldRow, TableRow } from '../../fields/service.js';
import { AppError } from '../../lib/errors.js';
import { decodeLinks, linkSpecs, selfColumn } from '../../records/links.js';
import { castFromJson, qualified, readExpression } from '../columns.js';
import {
  junctionOf,
  type LinkRead,
  linkReadExpr,
  otherSide,
  selfPosition,
  targetOf,
} from '../links.js';
import type { OutboxEvent } from '../outbox.js';
import { emitMany } from '../outbox.js';
import { computeFormulaValues, normalizeFormula } from './formula.js';
import {
  type ComputedNode,
  DependencyGraph,
  type FormulaGraphNode,
  type GraphField,
  resolveNode,
} from './graph.js';

/**
 * The recompute engine. Lookup, rollup and count values live in their fields' own columns
 * (`computed` storage), so views sort and filter them like any column; they're written only
 * here, in the transaction of the change that made them stale:
 *
 * 1. The caller says which fields changed for which records (`Dirty`: a written cell, a link
 *    written on either side, a record created, deleted or restored, a field created or
 *    converted).
 * 2. The engine walks the base's dependency graph (graph.ts) in dependency order. A computed
 *    field is stale for the records whose link cell changed, and for the records linking to a
 *    record whose source value changed (one junction query).
 * 3. It reads the linked live records' values (one query per field), aggregates them with the
 *    registry's pure functions (`lookupValue`, `rollupValue`), writes only the values that
 *    differ (batched `UPDATE … IS DISTINCT FROM … RETURNING id`), and passes the records that
 *    really changed on to the fields downstream.
 *
 * A computed field with more stale records than the sync limit (5,000 by default) isn't
 * recomputed in the request: it's flagged (`fields.recompute_requested_at`, the API's
 * `recomputing`) and a `field.recomputing` event takes it to the worker (jobs/computed.ts), which
 * recomputes it for every record in pages of its own transactions (`recomputeInPages`).
 *
 * A link's cells show the linked records' primary values, so a changed primary value makes the
 * lookups and formulas reading a link to that table stale too (two hops).
 *
 * Formula fields are nodes of the same graph: they recompute for the records whose
 * referenced cells changed, evaluated in JS (formula.ts), in the same dependency order.
 */

/** Field id → ids of records (of that field's table) whose value changed or must recompute. */
export type Dirty = Map<string, Set<string>>;

export function markDirty(dirty: Dirty, fieldId: string, ids: Iterable<string>): void {
  let set = dirty.get(fieldId);
  if (!set) {
    set = new Set();
    dirty.set(fieldId, set);
  }
  for (const id of ids) set.add(id);
}

/** Who made the change, for the `record.updated` events of recomputed records. */
export interface ChangeContext {
  workspaceId: string;
  /** The writer; null for a public form's submission. */
  userId: string | null;
  clientOpId?: string;
}

interface BaseGraph {
  graph: DependencyGraph;
  rows: Map<string, FieldRow>;
  tables: Map<string, TableRow>;
}

const CHUNK = 5000;

/** Stale records per computed field a request recomputes itself; more go to the worker. */
export const DEFAULT_SYNC_LIMIT = 5000;
let syncLimit = DEFAULT_SYNC_LIMIT;

/** Sets the sync limit (COMPUTED_SYNC_LIMIT; createApp). */
export function setRecomputeSyncLimit(limit: number): void {
  syncLimit = limit;
}

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function defOf(row: FieldRow): { def: FieldTypeDef; options: unknown } | null {
  if (!isFieldTypeName(row.type)) return null;
  const def = getFieldType(row.type);
  const parsed = def.optionsSchema.safeParse(row.config ?? {});
  return { def, options: parsed.success ? parsed.data : def.optionsSchema.parse({}) };
}

/** The base's live fields and tables (RLS-scoped), as a dependency graph. */
export async function loadGraph(tx: Transaction, baseId: string): Promise<BaseGraph> {
  const rows = await tx
    .select({ field: fields, table: tables })
    .from(fields)
    .innerJoin(tables, eq(fields.tableId, tables.id))
    .where(and(eq(tables.baseId, baseId), isNull(fields.deletedAt), isNull(tables.deletedAt)));
  const graph = new DependencyGraph(
    rows.map(({ field }) => ({
      id: field.id,
      tableId: field.tableId,
      type: field.type,
      options: defOf(field)?.options ?? {},
    }))
  );
  return {
    graph,
    rows: new Map(rows.map(({ field }) => [field.id, field])),
    tables: new Map(rows.map(({ table }) => [table.id, table])),
  };
}

/** The table a link field links to. */
function linkedTableOf(link: FieldRow): string | null {
  return linkOptionsSchema.safeParse(link.config ?? {}).data?.linkedTableId ?? null;
}

/** The junction of a link field, as its table sees it. */
function linkRead(g: BaseGraph, linkFieldId: string): LinkRead | null {
  const link = g.rows.get(linkFieldId);
  const table = link && g.tables.get(link.tableId);
  const targetId = link && linkedTableOf(link);
  const target = targetId ? g.tables.get(targetId) : undefined;
  if (link?.type !== 'link' || !table || !target) return null;
  return {
    schema: table.dbSchema,
    junction: link.dbColumn,
    self: selfColumn(link),
    target,
    primary: null,
  };
}

/** Records of the link's table linking to any of `ids` (records of the linked table). */
async function linkers(tx: Transaction, l: LinkRead, ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const batch of chunks(ids)) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT DISTINCT j.${sql.identifier(l.self)} AS id FROM ${junctionOf(l)} AS j
       WHERE j.${sql.identifier(otherSide(l))} = ANY(${uuidArray(batch)})`);
    for (const r of rows) out.push(r.id);
  }
  return out;
}

/** `FROM … WHERE` over the live linked records (`r`) of the records `ids` (`j.<self>`). */
function linkedFrom(l: LinkRead, ids: readonly string[]): SQL {
  return sql`FROM ${junctionOf(l)} AS j
    JOIN ${targetOf(l)} AS r ON r.id = j.${sql.identifier(otherSide(l))}
   WHERE j.${sql.identifier(l.self)} = ANY(${uuidArray(ids)}) AND r.deleted_at IS NULL`;
}

/** The new values of a computed field for `ids`, as its def's values (`null` when empty). */
async function computeValues(
  tx: Transaction,
  g: BaseGraph,
  node: ComputedNode,
  l: LinkRead,
  ids: readonly string[]
): Promise<Map<string, unknown>> {
  const own = g.rows.get(node.field.id);
  const ownDef = own && defOf(own);
  // What a record with no linked records gets (SUM is 0, COUNTALL 0, a lookup is empty).
  const empty =
    ownDef && node.field.type === 'rollup'
      ? rollupValue([], ownDef.options as RollupOptions)
      : null;
  const out = new Map<string, unknown>(ids.map((id) => [id, empty]));
  if (!ownDef) return out;
  if (node.field.type === 'count') {
    for (const id of ids) out.set(id, 0);
    const { rows } = await tx.execute<{ id: string; n: number }>(sql`
      SELECT j.${sql.identifier(l.self)} AS id, count(*)::int AS n ${linkedFrom(l, ids)} GROUP BY 1`);
    for (const r of rows) out.set(r.id, Number(r.n));
    return out;
  }
  const sourceRow = node.source && g.rows.get(node.source.id);
  const source = sourceRow && defOf(sourceRow);
  const sourceTable = g.tables.get(node.linkedTableId);
  if (!sourceRow || !source || !sourceTable) return out;
  // A link source reads its own junction (its names come from its linked table's primary).
  const sourceLink =
    sourceRow.type === 'link'
      ? (await linkSpecs(tx, sourceTable, [sourceRow])).get(sourceRow.id)?.read
      : undefined;
  if (sourceRow.type === 'link' && !sourceLink) return out;
  const value = sourceLink
    ? linkReadExpr(sourceLink)
    : readExpression({ type: sourceRow.type, dbColumn: sourceRow.dbColumn });
  const order = sql`j.${sql.identifier(selfPosition(l))}, j.${sql.identifier(otherSide(l))}`;
  const { rows } = await tx.execute<{ id: string; v: unknown }>(sql`
    SELECT j.${sql.identifier(l.self)} AS id, ${value} AS v ${linkedFrom(l, ids)}
     ORDER BY j.${sql.identifier(l.self)}, ${order}`);
  const grouped = new Map<string, unknown[]>();
  for (const r of rows) {
    const raw = sourceLink ? decodeLinks(sourceLink, r.v) : r.v;
    const list = grouped.get(r.id) ?? [];
    list.push(source.def.fromStorage(raw, source.options));
    grouped.set(r.id, list);
  }
  for (const [id, values] of grouped) {
    out.set(
      id,
      node.field.type === 'lookup'
        ? lookupValue(source, values)
        : rollupValue(rollupItems(source, values), ownDef.options as RollupOptions)
    );
  }
  return out;
}

/** Writes the values that differ from the stored ones; returns the records that changed. */
/** Writes the values that differ from the stored ones; returns the records written. */
export async function writeChanged(
  tx: Transaction,
  table: TableRow,
  row: FieldRow,
  def: FieldTypeDef,
  options: unknown,
  values: Map<string, unknown>
): Promise<string[]> {
  const type = def.storage.sqlType;
  const column = sql.identifier(row.dbColumn);
  const changed: string[] = [];
  for (const batch of chunks([...values])) {
    const json = JSON.stringify(
      batch.map(([id, v]) => ({ id, v: def.toStorage(v as never, options) }))
    );
    const { rows } = await tx.execute<{ id: string }>(sql`
      UPDATE ${qualified(table)} AS r SET ${column} = s.val
        FROM (SELECT (e->>'id')::uuid AS id, ${castFromJson(sql`e->'v'`, type)} AS val
                FROM jsonb_array_elements(${json}::jsonb) AS e) AS s
       WHERE r.id = s.id AND r.${column} IS DISTINCT FROM s.val
      RETURNING r.id`);
    for (const r of rows) changed.push(r.id);
  }
  return changed;
}

/** Every record id of a table, deleted ones included (they keep correct values for a restore). */
async function allIds(tx: Transaction, table: TableRow): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`SELECT id FROM ${qualified(table)}`);
  return rows.map((r) => r.id);
}

export interface RecomputeOptions {
  /** Emit `record.updated` for recomputed records (record writes); schema changes don't. */
  events?: ChangeContext;
  /** Computed fields to recompute for every record (a field created or reconfigured). */
  full?: readonly string[];
  /**
   * The worker's recompute: nothing is deferred past the sync limit, and no per-record
   * events are written; the changed fields are collected in `touched` instead.
   */
  background?: { touched: Map<string, Set<string>> };
  /** What NOW() and TODAY() read (UTC ms; default: the current time). */
  now?: number;
  /**
   * `false`: the change doesn't ask AI fields for new answers (the AI job's own writes, so
   * AI answers never set off more requests). `skip`: records not to ask for (deleted or restored
   * ones; the records linking to them still are).
   */
  ai?: false | { skip: readonly string[] };
}

/**
 * Recomputes every computed field of the base that `dirty` makes stale, in dependency order,
 * and emits a `record.updated` event (the new cells, `computed: true`) per changed record when
 * `events` is given. Returns the number of cells that changed.
 */
export async function recompute(
  tx: Transaction,
  baseId: string,
  dirty: Dirty,
  opts: RecomputeOptions = {}
): Promise<number> {
  if (!dirty.size && !opts.full?.length) return 0;
  const g = await loadGraph(tx, baseId);
  if (!g.graph.size && !hasAiFields(g, opts)) return 0;
  return run(tx, g, baseId, dirty, opts);
}

/**
 * Recomputes after records of a table were created, deleted or restored: their own computed
 * fields, and those of the records linking to them (deleted records drop out of every link
 * cell that names them, on either side or through a self-link).
 */
export async function recomputeForRecords(
  tx: Transaction,
  table: TableRow,
  ids: readonly string[],
  opts: RecomputeOptions = {}
): Promise<number> {
  if (!ids.length) return 0;
  const g = await loadGraph(tx, table.baseId);
  if (!g.graph.size && !hasAiFields(g, opts)) return 0;
  const dirty: Dirty = new Map();
  for (const row of g.rows.values()) {
    if (row.tableId === table.id) markDirty(dirty, row.id, ids);
    if (row.type !== 'link') continue;
    const l = linkedTableOf(row) === table.id ? linkRead(g, row.id) : null;
    if (l) markDirty(dirty, row.id, await linkers(tx, l, ids));
  }
  return run(tx, g, table.baseId, dirty, opts);
}

async function run(
  tx: Transaction,
  g: BaseGraph,
  baseId: string,
  dirty: Dirty,
  opts: RecomputeOptions
): Promise<number> {
  const full = opts.full ?? [];
  const fullSet = new Set(full);
  const changes = new Map<string, { tableId: string; cells: Record<string, unknown> }>();
  let total = 0;
  const now = opts.now ?? Date.now();
  const deferred: string[] = [];
  const defer = (id: string, stale: Set<string>) => {
    if (opts.background || stale.size <= syncLimit) return false;
    // Left for the worker; the fields downstream catch up when it recomputes this one.
    deferred.push(id);
    dirty.set(id, new Set());
    return true;
  };
  await markLinkNames(tx, g, dirty);
  for (const id of g.graph.downstream([...dirty.keys(), ...full])) {
    const formula = g.graph.formulas.get(id);
    if (formula) {
      const changed = await recomputeFormula(tx, g, formula, dirty, fullSet.has(id), now, defer);
      total += changed.ids.length;
      if (changed.ids.length) touch(opts, formula.field.tableId, id);
      if (opts.events) {
        for (const recordId of changed.ids) {
          const entry = changes.get(recordId) ?? { tableId: formula.field.tableId, cells: {} };
          entry.cells[id] = changed.values.get(recordId) ?? null;
          changes.set(recordId, entry);
        }
      }
      continue;
    }
    const node = g.graph.nodes.get(id);
    const row = g.rows.get(id);
    const table = g.tables.get(node?.field.tableId ?? '');
    const own = row && defOf(row);
    const l = node && linkRead(g, node.link.id);
    if (!node || !row || !table || !own || !l) continue;
    let stale: Set<string>;
    if (fullSet.has(id)) {
      stale = new Set(await allIds(tx, table));
    } else {
      stale = new Set([...(dirty.get(node.link.id) ?? []), ...(dirty.get(id) ?? [])]);
      const sourceDirty = node.source ? dirty.get(node.source.id) : undefined;
      if (sourceDirty?.size) for (const r of await linkers(tx, l, [...sourceDirty])) stale.add(r);
    }
    if (!stale.size || defer(id, stale)) continue;
    const values = await computeValues(tx, g, node, l, [...stale]);
    const changed = await writeChanged(tx, table, row, own.def, own.options, values);
    dirty.set(id, new Set(changed));
    total += changed.length;
    if (changed.length) touch(opts, table.id, id);
    if (opts.events) {
      for (const recordId of changed) {
        const entry = changes.get(recordId) ?? { tableId: table.id, cells: {} };
        entry.cells[id] = values.get(recordId) ?? null;
        changes.set(recordId, entry);
      }
    }
  }
  const ev = opts.events;
  if (ev && changes.size) {
    const events: OutboxEvent[] = [...changes].map(([recordId, c]) => ({
      workspaceId: ev.workspaceId,
      baseId,
      tableId: c.tableId,
      kind: 'record.updated',
      payload: { recordId, fieldIds: Object.keys(c.cells), cells: c.cells, computed: true },
      actorId: ev.userId,
      ...(ev.clientOpId ? { clientOpId: ev.clientOpId } : {}),
    }));
    await emitMany(tx, events);
  }
  if (deferred.length) await requestRecompute(tx, g, baseId, deferred, ev?.userId ?? null);
  if (opts.ai !== false) {
    const skip = new Set(opts.ai?.skip ?? []);
    await requestAiAnswers(tx, g, baseId, dirty, skip, ev?.userId ?? null);
  }
  // A flagged field recomputed whole right here (restored, reconfigured) has nothing left to wait
  // for; a job finding it unflagged has nothing to do.
  const done = full.filter((id) => !deferred.includes(id));
  if (done.length && !opts.background) {
    await tx
      .update(fields)
      .set({ recomputeRequestedAt: null })
      .where(
        and(sql`${fields.id} = ANY(${uuidArray(done)})`, isNotNull(fields.recomputeRequestedAt))
      );
  }
  return total;
}

/** Whether the base has AI fields a change may ask for answers. */
function hasAiFields(g: BaseGraph, opts: RecomputeOptions): boolean {
  return opts.ai !== false && [...g.rows.values()].some((r) => r.type === 'ai');
}

/**
 * AI fields whose prompt reads a field that changed (`dirty` after the recompute, so a
 * changed formula or lookup counts too) get those records' cells marked pending for the worker,
 * unless the field's `autoUpdate` is off. Deleted records are skipped by the job.
 */
async function requestAiAnswers(
  tx: Transaction,
  g: BaseGraph,
  baseId: string,
  dirty: Dirty,
  skip: ReadonlySet<string>,
  actorId: string | null
) {
  const woken = new Map<string, TableRow>();
  for (const row of g.rows.values()) {
    if (row.type !== 'ai') continue;
    const options = aiOptionsOf(row.config);
    if (!options.autoUpdate || !options.prompt) continue;
    const stale = new Set<string>();
    for (const ref of options.referencedFieldIds) {
      if (g.rows.get(ref)?.tableId !== row.tableId) continue;
      for (const id of dirty.get(ref) ?? []) if (!skip.has(id)) stale.add(id);
    }
    if (!stale.size) continue;
    await markAiPending(tx, row, [...stale]);
    await emitAiStatus(tx, row, baseId, actorId);
    const table = g.tables.get(row.tableId);
    if (table) woken.set(table.id, table);
  }
  for (const table of woken.values()) await wakeAiWorker(tx, table, actorId);
}

function touch(opts: RecomputeOptions, tableId: string, fieldId: string) {
  const touched = opts.background?.touched;
  if (!touched) return;
  const set = touched.get(tableId) ?? new Set<string>();
  touched.set(tableId, set.add(fieldId));
}

/**
 * Flags computed fields for the worker's recompute and emits `field.recomputing` per
 * field: clients show the column as updating, and the outbox relay hands the base to the
 * `computed.refresh` job (jobs/computed.ts).
 */
async function requestRecompute(
  tx: Transaction,
  g: BaseGraph,
  baseId: string,
  fieldIds: readonly string[],
  actorId: string | null
) {
  await tx
    .update(fields)
    .set({ recomputeRequestedAt: sql`date_trunc('milliseconds', clock_timestamp())` })
    .where(sql`${fields.id} = ANY(${uuidArray(fieldIds)})`);
  const events: OutboxEvent[] = fieldIds.flatMap((fieldId) => {
    const row = g.rows.get(fieldId);
    const table = row && g.tables.get(row.tableId);
    if (!table) return [];
    return [
      {
        workspaceId: table.workspaceId,
        baseId,
        tableId: table.id,
        kind: 'field.recomputing' as const,
        payload: { fieldId },
        actorId,
      },
    ];
  });
  await emitMany(tx, events);
}

/**
 * A link cell shows the linked records' primary values: when a primary value changed, the link
 * fields pointing at its table count as changed for the records linking to the changed ones, as
 * far as a lookup or formula reads those links (two hops). Downstream of that, the graph
 * carries the change any number of hops.
 */
async function markLinkNames(tx: Transaction, g: BaseGraph, dirty: Dirty) {
  const primaries = [...g.rows.values()].filter((r) => r.isPrimary && dirty.get(r.id)?.size);
  for (const primary of primaries) {
    const ids = [...(dirty.get(primary.id) ?? [])];
    for (const link of g.rows.values()) {
      if (link.type !== 'link' || linkedTableOf(link) !== primary.tableId) continue;
      if (!readsLinkNames(g.graph, link.id)) continue;
      const l = linkRead(g, link.id);
      if (l) markDirty(dirty, link.id, await linkers(tx, l, ids));
    }
  }
}

/** Whether a computed field reads a link field's names (a lookup of it, a formula on it). */
function readsLinkNames(graph: DependencyGraph, linkId: string): boolean {
  return graph
    .directDependents(linkId)
    .some(
      (d) =>
        graph.nodes.get(d)?.source?.id === linkId ||
        (graph.formulas.get(d)?.deps.some((x) => x.id === linkId) ?? false)
    );
}

/** Recomputes a formula field for its stale records; returns the records that changed. */
async function recomputeFormula(
  tx: Transaction,
  g: BaseGraph,
  formula: FormulaGraphNode,
  dirty: Dirty,
  full: boolean,
  now: number,
  defer: (id: string, stale: Set<string>) => boolean
): Promise<{ ids: string[]; values: Map<string, unknown> }> {
  const id = formula.field.id;
  const row = g.rows.get(id);
  const table = g.tables.get(formula.field.tableId);
  const own = row && defOf(row);
  if (!row || !table || !own) return { ids: [], values: new Map() };
  let stale: Set<string>;
  if (full) {
    stale = new Set(await allIds(tx, table));
  } else {
    stale = new Set(dirty.get(id) ?? []);
    for (const dep of formula.deps) for (const r of dirty.get(dep.id) ?? []) stale.add(r);
    if (formula.readsAnyChange) {
      for (const [fieldId, records] of dirty) {
        if (g.rows.get(fieldId)?.tableId === table.id) for (const r of records) stale.add(r);
      }
    }
  }
  if (!stale.size || defer(id, stale)) return { ids: [], values: new Map() };
  const deps = formula.deps.flatMap((d) => g.rows.get(d.id) ?? []);
  const results = await computeFormulaValues(tx, table, formula.ast, deps, [...stale], now);
  // The field's own type reads the result: a button keeps only an http(s) URL.
  const values = new Map<string, unknown>();
  for (const [recordId, v] of results) values.set(recordId, own.def.coerce(v, own.options));
  const changed = await writeChanged(tx, table, row, own.def, own.options, values);
  dirty.set(id, new Set(changed));
  return { ids: changed, values };
}

/**
 * Checks a formula field's options against its table before it's saved and gives the options to
 * store (the stored form, result type and referenced fields, formula.ts): a formula that doesn't
 * parse or type-check, or that would read itself through other computed fields, is a 422.
 */
export async function prepareFormula(
  tx: Transaction,
  baseId: string,
  candidate: GraphField & { name: string }
): Promise<unknown> {
  const g = await loadGraph(tx, baseId);
  // A formula's options, or a button's (a label besides the formula keys).
  const def = isFieldTypeName(candidate.type) ? getFieldType(candidate.type) : null;
  const parsed = (def ?? { optionsSchema: formulaOptionsSchema }).optionsSchema.parse(
    candidate.options ?? {}
  ) as FormulaOptions;
  const tableFields = [...g.rows.values()].filter(
    (r) => r.tableId === candidate.tableId && r.id !== candidate.id
  );
  const self = { id: candidate.id, name: candidate.name, type: candidate.type, config: {} };
  const normalized = normalizeFormula(parsed, [...tableFields, self]);
  if (!normalized.ok) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The formula is invalid.',
      extensions: {
        errors: normalized.errors.map((e) => ({
          path: 'options.formula',
          message: e.message,
          code: e.code,
          range: e.range,
        })),
      },
    });
  }
  const options = normalized.options;
  const cycle = g.graph.cycleThrough({ ...candidate, options });
  if (cycle) {
    const names = cycle.map((fid) =>
      fid === candidate.id ? candidate.name : (g.rows.get(fid)?.name ?? 'this field')
    );
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The formula is invalid.',
      extensions: {
        errors: [
          {
            path: 'options.formula',
            message: `This would make a circular reference (${names.join(' → ')}).`,
          },
        ],
      },
    });
  }
  return options;
}

/**
 * Checks a lookup, rollup or count field's options against the base before it's saved: the link
 * field must be a live link of its table, the source a live field of the linked table, and the
 * field mustn't read itself through any chain of lookups and rollups (422 otherwise).
 */
export async function assertValidComputed(
  tx: Transaction,
  baseId: string,
  candidate: GraphField & { isPrimary?: boolean }
): Promise<void> {
  if (!computedSourceOf(candidate.type, candidate.options)) return;
  const invalid = (path: string, message: string): never => {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The field options are invalid.',
      extensions: { errors: [{ path, message }] },
    });
  };
  if (candidate.isPrimary) invalid('type', "The primary field can't be a lookup, rollup or count.");
  const g = await loadGraph(tx, baseId);
  const byId = new Map(g.graph.byId);
  byId.set(candidate.id, candidate);
  const { problem } = resolveNode(candidate, byId);
  if (problem) invalid(problem.path, problem.message);
  const cycle = g.graph.cycleThrough(candidate);
  if (cycle) {
    const names = cycle.map((id) => g.rows.get(id)?.name ?? 'this field');
    invalid(
      'options.fieldIdInLinkedTable',
      `This would make a circular reference (${names.join(' → ')}).`
    );
  }
}

/** The live computed fields that read `fieldIds` (as their link or source), by name. */
export async function dependentsOf(
  tx: Transaction,
  baseId: string,
  fieldIds: readonly string[]
): Promise<FieldRow[]> {
  const g = await loadGraph(tx, baseId);
  const ids = new Set(fieldIds.flatMap((id) => g.graph.directDependents(id)));
  for (const id of fieldIds) ids.delete(id);
  return [...ids].flatMap((id) => g.rows.get(id) ?? []);
}

/**
 * Recomputes after a schema change to `fieldId` (created, reconfigured, converted, restored):
 * the field itself for every record if it's computed, and every computed field reading it.
 */
export async function refreshField(tx: Transaction, baseId: string, fieldId: string) {
  const g = await loadGraph(tx, baseId);
  const full = [...(g.graph.has(fieldId) ? [fieldId] : []), ...g.graph.directDependents(fieldId)];
  if (!full.length) return 0;
  return run(tx, g, baseId, new Map(), { full });
}

/** Recomputes every computed field of `tableId` for every record (a table back from the trash). */
export async function refreshTable(tx: Transaction, baseId: string, tableId: string) {
  const g = await loadGraph(tx, baseId);
  const full = [...g.rows.values()]
    .filter((f) => f.tableId === tableId && g.graph.has(f.id))
    .map((f) => f.id);
  if (!full.length) return 0;
  return run(tx, g, baseId, new Map(), { full });
}

/** Records per transaction of the worker's recomputes. */
export const PAGE_SIZE = 1000;

/**
 * The worker's recompute: `fieldIds` (computed fields of `table`) for every record of the
 * table, deleted ones included, in pages of `pageSize` records by id, each page in its own
 * transaction (`inTx` opens one in the tenant's scope); the fields downstream follow each page.
 * Collects the fields whose values changed, by table, in `touched`. Returns the changed cells.
 */
export async function recomputeInPages(
  inTx: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>,
  table: Pick<TableRow, 'id' | 'baseId' | 'dbSchema' | 'dbTable'>,
  fieldIds: readonly string[],
  opts: { touched: Map<string, Set<string>>; now?: number; pageSize?: number }
): Promise<number> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const page: { ids: string[]; changed: number } = await inTx(async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        SELECT id FROM ${qualified(table)}
         ${after ? sql`WHERE id > ${after}::uuid` : sql``}
         ORDER BY id LIMIT ${pageSize}`);
      const ids = rows.map((r) => r.id);
      if (!ids.length) return { ids, changed: 0 };
      const g = await loadGraph(tx, table.baseId);
      const live = fieldIds.filter((id) => g.graph.has(id));
      if (!live.length) return { ids: [], changed: 0 };
      const dirty: Dirty = new Map();
      for (const id of live) markDirty(dirty, id, ids);
      const changed = await run(tx, g, table.baseId, dirty, {
        background: { touched: opts.touched },
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      return { ids, changed };
    });
    total += page.changed;
    if (page.ids.length < pageSize) return total;
    after = page.ids.at(-1) ?? null;
  }
}

/**
 * Re-derives the stored result type of the formulas reading `fieldId` (directly, or through
 * other formulas of its table) after its type or formula changed: each is type-checked
 * again against the table's fields, in dependency order, and its options rewritten when the
 * result type or validity changed (a formula that no longer type-checks keeps its text with
 * `isValid: false`). Returns the rewritten field rows; the caller emits their `field.updated`.
 */
export async function rederiveFormulas(
  tx: Transaction,
  baseId: string,
  fieldId: string
): Promise<FieldRow[]> {
  const g = await loadGraph(tx, baseId);
  const tableId = g.rows.get(fieldId)?.tableId;
  const ids = g.graph
    .downstream([fieldId])
    .filter((id) => id !== fieldId && g.graph.formulas.get(id)?.field.tableId === tableId);
  const rows = new Map(g.rows);
  const out: FieldRow[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    const own = row && defOf(row);
    if (!row || !own) continue;
    const current = own.options as FormulaOptions;
    const tableFields = [...rows.values()].filter((r) => r.tableId === tableId && r.id !== id);
    const self = { id, name: row.name, type: row.type, config: {} };
    const normalized = normalizeFormula(current, [...tableFields, self]);
    const next: FormulaOptions = normalized.ok
      ? (normalized.options as FormulaOptions)
      : { ...current, isValid: false };
    if (next.resultType === current.resultType && next.isValid === current.isValid) continue;
    const [updated] = await tx
      .update(fields)
      .set({ config: next, updatedAt: new Date() })
      .where(eq(fields.id, id))
      .returning();
    if (!updated) continue;
    rows.set(id, updated);
    out.push(updated);
  }
  return out;
}
