import type {
  AirtableReport,
  AirtableReportField,
  FieldTypeName,
  LinkOptions,
  ViewType,
} from '@openrows/shared';
import { MAX_AIRTABLE_REPORT_ITEMS } from '@openrows/shared';
import type { bases, Transaction } from '../db/index.js';
import {
  createField,
  type FieldRow,
  fieldType,
  liveFields,
  MAX_FIELDS_PER_TABLE,
  parseOptions,
  type SchemaContext,
  type TableRow,
  updateField,
} from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { createTable, loadTable } from '../tables/service.js';
import { createView, liveViews, updateView } from '../views/service.js';
import type { AirtableTable } from './client.js';
import {
  formulaProblem,
  missingFields,
  type PlannedField,
  readableFormula,
  storedFormula,
  type TablePlan,
  writable,
} from './mapping.js';
import { planView } from './views.js';

/**
 * The schema step of an Airtable import, in one transaction: every table with its
 * primary and plain fields, then the links between them (an Airtable link and its inverse
 * become one of our link fields and its inverse), then formulas, lookups, rollups and counts in
 * rounds (one waits for the fields it reads, across tables), then the views (views.ts).
 */

export interface FieldState {
  airtableId: string;
  airtableType: string;
  fieldId: string;
  type: FieldTypeName;
  /** Values come from Airtable (false: we compute them, or the links pass writes them). */
  copy: boolean;
  /** A link field: its cells' Airtable record ids go to the record map. */
  link?: boolean;
}

export interface TableState {
  airtableId: string;
  tableId: string;
  name: string;
  fields: FieldState[];
  records: number;
}

/** One side of a link: the field, its table and the table it links to. */
export interface LinkSide {
  tableId: string;
  fieldId: string;
  linkedTableId: string;
}

/** A link pair the links pass fills: from the side whose cells hold the fewest links. */
export interface LinkPair {
  a: LinkSide;
  /** The inverse side, when Airtable has it too (null: a one-way or self link). */
  b: LinkSide | null;
  writer?: 'a' | 'b';
}

export const capped = <T>(list: T[], item: T) => {
  if (list.length < MAX_AIRTABLE_REPORT_ITEMS) list.push(item);
};

/** In a savepoint: a refused field leaves the rest of the schema step alone. */
export async function attempt<T>(tx: Transaction, fn: (sp: Transaction) => Promise<T>) {
  try {
    return { ok: true as const, value: await tx.transaction((sp) => fn(sp as Transaction)) };
  } catch (err) {
    if (err instanceof AppError)
      return { ok: false as const, message: err.detail ?? err.message, err };
    throw err;
  }
}

/** The first problem of a refused formula or computed field, for the report. */
function problemOf(err: AppError, stored?: string, nameOf?: (id: string) => string | undefined) {
  const errors = (err.extensions?.['errors'] ?? []) as Parameters<typeof formulaProblem>[1][];
  const first = errors[0];
  if (!first?.message) return err.detail ?? err.message;
  return stored !== undefined && nameOf ? formulaProblem(stored, first, nameOf) : first.message;
}

interface Built {
  plan: TablePlan;
  table: TableRow;
  state: TableState;
  /** Fields in the table, ours (the inverse links included). */
  count: number;
}

export async function buildSchema(
  ctx: SchemaContext,
  base: typeof bases.$inferSelect,
  plans: TablePlan[],
  sources: readonly AirtableTable[],
  report: AirtableReport
): Promise<{ tables: TableState[]; links: LinkPair[] }> {
  const ids = new Map<string, string>();
  // Field names for the report: ours, and Airtable's for fields left out.
  const names = new Map([
    ...sources.flatMap((t) => t.fields.map((f) => [f.id, f.name] as const)),
    ...plans.flatMap((p) => p.fields.map((f) => [f.airtableId, f.name] as const)),
  ]);
  const built: Built[] = [];
  for (const plan of plans) built.push(await createTableFrom(ctx, base, plan, report, ids, names));
  const byAirtable = new Map(built.map((b) => [b.plan.airtableId, b]));
  const links = await createLinks(ctx, built, byAirtable, report, ids);
  await createComputed(ctx, built, report, ids, names);
  for (const b of built) {
    const source = sources.find((t) => t.id === b.plan.airtableId);
    if (source) await createViews(ctx, b, source, report, ids);
  }
  return { tables: built.map((b) => b.state), links };
}

const reportOf = (plan: TablePlan, f: PlannedField): Omit<AirtableReportField, 'message'> => ({
  table: plan.name,
  field: f.name,
  type: f.airtableType,
});

const tooMany = `A table holds at most ${MAX_FIELDS_PER_TABLE} fields.`;

async function createTableFrom(
  ctx: SchemaContext,
  base: typeof bases.$inferSelect,
  plan: TablePlan,
  report: AirtableReport,
  ids: Map<string, string>,
  names: ReadonlyMap<string, string>
): Promise<Built> {
  const { tx } = ctx;
  const primary = plan.fields.find((f) => f.isPrimary) ?? plan.fields[0];
  const created = await createTable(ctx, base, {
    name: plan.name,
    ...(plan.description ? { description: plan.description } : {}),
    primaryFieldName: primary?.name ?? 'Name',
  });
  const table = await loadTable(tx, created.id);
  for (const u of plan.unsupported) capped(report.unsupportedFields, u);
  const fields: FieldState[] = [];

  // The primary field: created as text with the table; another type where ours allows it.
  const primaryRow = (await liveFields(tx, table.id)).find((f) => f.isPrimary);
  if (primary && primaryRow) {
    let type: FieldTypeName = 'singleLineText';
    if (primary.formula !== undefined) {
      capped(report.untranslatedFormulas, {
        ...reportOf(plan, primary),
        formula: readableFormula(primary.formula, names),
        message: "A primary field can't be a formula here: kept as text with its values.",
      });
    } else if (primary.type !== 'singleLineText') {
      const changed = await attempt(tx, (sp) =>
        updateField({ ...ctx, tx: sp }, primaryRow, {
          type: primary.type,
          options: primary.options,
          ...(primary.description ? { description: primary.description } : {}),
        })
      );
      if (changed.ok) type = primary.type;
      else {
        capped(report.converted, {
          ...reportOf(plan, primary),
          message: 'The primary field was kept as text.',
        });
      }
    }
    if (primary.converted)
      capped(report.converted, { ...reportOf(plan, primary), message: primary.converted });
    fields.push({
      airtableId: primary.airtableId,
      airtableType: primary.airtableType,
      fieldId: primaryRow.id,
      type,
      copy: true,
    });
    if (primary.formula === undefined) ids.set(primary.airtableId, primaryRow.id);
  }

  const out: Built = {
    plan,
    table,
    state: { airtableId: plan.airtableId, tableId: table.id, name: plan.name, fields, records: 0 },
    count: 1,
  };
  // Plain fields; links, formulas and computed fields come once every table exists.
  for (const f of plan.fields) {
    if (f.isPrimary || f.formula !== undefined || f.link || f.computed) continue;
    if (out.count >= MAX_FIELDS_PER_TABLE) {
      capped(report.unsupportedFields, { ...reportOf(plan, f), message: tooMany });
      continue;
    }
    const made = await attempt(tx, (sp) =>
      createField({ ...ctx, tx: sp }, table, {
        name: f.name,
        type: f.type,
        options: f.options,
        ...(f.description ? { description: f.description } : {}),
      })
    );
    if (!made.ok) {
      capped(report.unsupportedFields, { ...reportOf(plan, f), message: made.message });
      continue;
    }
    out.count++;
    if (f.converted) capped(report.converted, { ...reportOf(plan, f), message: f.converted });
    fields.push({
      airtableId: f.airtableId,
      airtableType: f.airtableType,
      fieldId: made.value.id,
      type: f.type,
      // Created time and created by: the job gives the records Airtable's values.
      copy: writable(f.type),
    });
    ids.set(f.airtableId, made.value.id);
  }
  return out;
}

/**
 * Airtable's links: each pair once. The first side becomes a link field, whose inverse (added
 * to the linked table) takes the name of Airtable's inverse field. A one-way Airtable link
 * still gets its inverse here (links go both ways), and a link to its own table has none.
 */
async function createLinks(
  ctx: SchemaContext,
  built: Built[],
  byAirtable: ReadonlyMap<string, Built>,
  report: AirtableReport,
  ids: Map<string, string>
): Promise<LinkPair[]> {
  const { tx } = ctx;
  const pairs: LinkPair[] = [];
  const handled = new Set<string>();
  for (const b of built) {
    for (const f of b.plan.fields) {
      const link = f.link;
      if (!link || handled.has(f.airtableId)) continue;
      handled.add(f.airtableId);
      const target = byAirtable.get(link.linkedTableId);
      if (!target) {
        capped(report.unsupportedFields, {
          ...reportOf(b.plan, f),
          message: "It links to a table that wasn't imported.",
        });
        continue;
      }
      const self = target === b;
      if (b.count >= MAX_FIELDS_PER_TABLE || (!self && target.count >= MAX_FIELDS_PER_TABLE)) {
        capped(report.unsupportedFields, { ...reportOf(b.plan, f), message: tooMany });
        continue;
      }
      const made = await attempt(tx, (sp) =>
        createField({ ...ctx, tx: sp }, b.table, {
          name: f.name,
          type: 'link',
          options: { linkedTableId: target.table.id, prefersSingleRecordLink: link.prefersSingle },
          ...(f.description ? { description: f.description } : {}),
        })
      );
      if (!made.ok) {
        capped(report.unsupportedFields, { ...reportOf(b.plan, f), message: made.message });
        continue;
      }
      b.count++;
      ids.set(f.airtableId, made.value.id);
      b.state.fields.push(linkState(f, made.value.id));
      const a: LinkSide = {
        tableId: b.table.id,
        fieldId: made.value.id,
        linkedTableId: target.table.id,
      };
      const inverseId = (parseOptions('link', made.value.config) as LinkOptions).inverseLinkFieldId;
      const theirs = link.inverseLinkFieldId
        ? target.plan.fields.find((x) => x.airtableId === link.inverseLinkFieldId && x.link)
        : undefined;
      if (theirs) handled.add(theirs.airtableId);
      if (!inverseId) {
        // A link to its own table: Airtable's inverse field has no counterpart here.
        if (theirs && theirs !== f) {
          capped(report.unsupportedFields, {
            ...reportOf(target.plan, theirs),
            message: `A link to its own table has no inverse field here: the links are in "${f.name}".`,
          });
        }
        pairs.push({ a, b: null });
        continue;
      }
      target.count++;
      const inverseRow = (await liveFields(tx, target.table.id)).find((x) => x.id === inverseId);
      if (!theirs || !inverseRow) {
        capped(report.converted, {
          ...reportOf(b.plan, f),
          message: `Links go both ways here: "${target.plan.name}" got the inverse field "${inverseRow?.name ?? b.plan.name}".`,
        });
        pairs.push({ a, b: null });
        continue;
      }
      await renameInverse(ctx, inverseRow, theirs);
      ids.set(theirs.airtableId, inverseId);
      target.state.fields.push(linkState(theirs, inverseId));
      pairs.push({
        a,
        b: { tableId: target.table.id, fieldId: inverseId, linkedTableId: b.table.id },
      });
    }
  }
  return pairs;
}

const linkState = (f: PlannedField, fieldId: string): FieldState => ({
  airtableId: f.airtableId,
  airtableType: f.airtableType,
  fieldId,
  type: 'link',
  copy: false,
  link: true,
});

/** The inverse field we added, as Airtable has it: its name, description and single link. */
async function renameInverse(ctx: SchemaContext, row: FieldRow, theirs: PlannedField) {
  const options = parseOptions('link', row.config) as LinkOptions;
  await attempt(ctx.tx, (sp) =>
    updateField({ ...ctx, tx: sp }, row, {
      name: theirs.name,
      ...(theirs.description ? { description: theirs.description } : {}),
      options: { ...options, prefersSingleRecordLink: theirs.link?.prefersSingle ?? false },
    })
  );
}

/** The Airtable fields a formula or computed field reads. */
function depsOf(f: PlannedField): string[] {
  if (f.computed) {
    return [
      f.computed.recordLinkFieldId,
      ...(f.computed.fieldIdInLinkedTable ? [f.computed.fieldIdInLinkedTable] : []),
    ];
  }
  return [...(f.formula ?? '').matchAll(/\{(fld[A-Za-z0-9]{14})\}/g)].map((m) => m[1] ?? '');
}

/**
 * Formulas, lookups, rollups and counts, in rounds: one waits for the formulas and computed
 * fields it reads (in any table). One that can't be made keeps Airtable's values: a formula as
 * text with the formula in its description, a computed field as a plain field of its result.
 */
async function createComputed(
  ctx: SchemaContext,
  built: Built[],
  report: AirtableReport,
  ids: Map<string, string>,
  names: ReadonlyMap<string, string>
) {
  const { tx } = ctx;
  type Pending = { b: Built; f: PlannedField };
  const planned = new Map(built.flatMap((b) => b.plan.fields.map((f) => [f.airtableId, f])));
  /** Why a field a formula reads isn't there to read, for the report. */
  const unreadable = (airtableId: string) => {
    const f = planned.get(airtableId);
    const name = f?.name ?? names.get(airtableId);
    const what =
      f?.formula !== undefined
        ? 'a formula kept as text here'
        : f?.computed
          ? `a ${f.computed.type} kept with Airtable's values`
          : f?.link
            ? "a link that wasn't imported"
            : "which wasn't imported";
    return name ? `It reads "${name}", ${what}.` : "It reads a field that wasn't imported.";
  };
  const nameOf = (fieldId: string) => {
    for (const [airtableId, ours] of ids) {
      if (ours === fieldId) return planned.get(airtableId)?.name ?? names.get(airtableId);
    }
    return undefined;
  };
  let pending: Pending[] = built.flatMap((b) =>
    b.plan.fields
      .filter((f) => !f.isPrimary && (f.formula !== undefined || f.computed))
      .map((f) => ({ b, f }))
  );

  const fallback = async ({ b, f }: Pending, message: string) => {
    if (f.formula !== undefined) {
      const formula = readableFormula(f.formula, names);
      capped(report.untranslatedFormulas, { ...reportOf(b.plan, f), formula, message });
    } else {
      capped(report.converted, {
        ...reportOf(b.plan, f),
        message: `Kept with Airtable's values: ${message}`,
      });
    }
    if (b.count >= MAX_FIELDS_PER_TABLE) return;
    const description =
      f.formula !== undefined
        ? [f.description, `Airtable formula: ${readableFormula(f.formula, names)}`]
            .filter(Boolean)
            .join('\n\n')
            .slice(0, 2000)
        : f.description;
    const made = await attempt(tx, (sp) =>
      createField({ ...ctx, tx: sp }, b.table, {
        name: f.name,
        type: f.type,
        options: f.options,
        ...(description ? { description } : {}),
      })
    );
    if (!made.ok) return;
    b.count++;
    b.state.fields.push({
      airtableId: f.airtableId,
      airtableType: f.airtableType,
      fieldId: made.value.id,
      type: f.type,
      copy: true,
    });
    // A rollup or count keeping Airtable's values holds them in its result's type, as
    // Airtable's did: formulas may read it. A formula kept as text, or a lookup (a list there,
    // text here), would read differently.
    if (f.computed && f.computed.type !== 'lookup') ids.set(f.airtableId, made.value.id);
  };

  const create = async ({ b, f }: Pending) => {
    let input: { type: FieldTypeName; options: Record<string, unknown> };
    if (f.computed) {
      const c = f.computed;
      input = {
        type: c.type,
        options: {
          recordLinkFieldId: ids.get(c.recordLinkFieldId),
          ...(c.type !== 'count'
            ? { fieldIdInLinkedTable: ids.get(c.fieldIdInLinkedTable ?? '') }
            : {}),
          ...(c.function ? { function: c.function } : {}),
          ...(c.separator !== undefined ? { separator: c.separator } : {}),
        },
      };
    } else {
      const stored = storedFormula(f.formula ?? '', ids);
      if (stored === null) {
        const missing = missingFields(f.formula ?? '', ids)[0] ?? '';
        return fallback({ b, f }, unreadable(missing));
      }
      input = { type: 'formula', options: { formula: stored } };
    }
    if (b.count >= MAX_FIELDS_PER_TABLE) {
      capped(report.unsupportedFields, { ...reportOf(b.plan, f), message: tooMany });
      return;
    }
    const made = await attempt(tx, (sp) =>
      createField({ ...ctx, tx: sp }, b.table, {
        name: f.name,
        ...input,
        ...(f.description ? { description: f.description } : {}),
      })
    );
    if (!made.ok) {
      const stored = input.type === 'formula' ? String(input.options['formula']) : undefined;
      return fallback({ b, f }, problemOf(made.err, stored, nameOf));
    }
    b.count++;
    b.state.fields.push({
      airtableId: f.airtableId,
      airtableType: f.airtableType,
      fieldId: made.value.id,
      type: input.type,
      copy: false,
    });
    ids.set(f.airtableId, made.value.id);
  };

  while (pending.length) {
    const waiting = new Set(pending.map((p) => p.f.airtableId));
    const ready = pending.filter((p) =>
      depsOf(p.f).every((d) => !waiting.has(d) || d === p.f.airtableId)
    );
    // A cycle, or fields reading each other: what's left can't be made.
    const batch = ready.length ? ready : pending;
    pending = pending.filter((p) => !batch.includes(p));
    for (const p of batch) {
      if (!ready.length) {
        await fallback(p, 'It reads a formula that reads it back.');
        continue;
      }
      const missing = p.f.computed ? depsOf(p.f).find((d) => !ids.has(d)) : undefined;
      if (missing !== undefined) {
        await fallback(p, unreadable(missing));
        continue;
      }
      await create(p);
    }
  }
}

/**
 * The table's views as views.ts plans them. The first grid view takes over the table's default
 * "Grid view". Each view created gets a report note (what was chosen here, what Airtable's API
 * doesn't share); one that can't be is listed with the reason.
 */
async function createViews(
  ctx: SchemaContext,
  b: Built,
  source: AirtableTable,
  report: AirtableReport,
  ids: ReadonlyMap<string, string>
) {
  const { tx } = ctx;
  const rights = { canLock: true };
  const ours = (await liveFields(tx, b.table.id)).map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    isPrimary: f.isPrimary,
    options: parseOptions(fieldType(f), f.config),
  }));
  let spare = (await liveViews(tx, b.table.id, ctx.userId)).find((v) => v.type === 'grid');
  for (const v of source.views) {
    const name = v.name.trim().slice(0, 255) || 'View';
    const line = { table: b.plan.name, view: name, type: v.type };
    const plan = planView(v, ours, ids);
    if (!plan.ok) {
      capped(report.unsupportedViews, { ...line, message: plan.message });
      continue;
    }
    const reuse = plan.type === 'grid' ? spare : undefined;
    if (reuse) spare = undefined;
    const made = await attempt(tx, async (sp) => {
      const sctx = { ...ctx, tx: sp };
      const row = reuse ?? (await createViewRow(sctx, b.table, name, plan.type));
      await updateView(sctx, row, { ...(reuse ? { name } : {}), ...plan.config }, rights);
    });
    if (made.ok) {
      report.views++;
      capped(report.partialViews, { ...line, message: plan.note });
    } else {
      capped(report.unsupportedViews, { ...line, message: made.message });
    }
  }
}

async function createViewRow(ctx: SchemaContext, table: TableRow, name: string, type: ViewType) {
  const view = await createView(ctx, table, { name, type });
  const row = (await liveViews(ctx.tx, table.id, ctx.userId)).find((v) => v.id === view.id);
  if (!row) throw new Error('airtable: the new view is gone');
  return row;
}
