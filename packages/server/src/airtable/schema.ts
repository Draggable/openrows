import type {
  AirtableReport,
  AirtableReportField,
  FieldTypeName,
  LinkOptions,
  UpdateViewInput,
} from '@openrows/shared';
import { MAX_AIRTABLE_REPORT_ITEMS } from '@openrows/shared';
import type { bases, Transaction } from '../db/index.js';
import {
  createField,
  type FieldRow,
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
import { type PlannedField, readableFormula, storedFormula, type TablePlan } from './mapping.js';

/**
 * The schema step of an Airtable import, in one transaction: every table with its
 * primary and plain fields, then the links between them (an Airtable link and its inverse
 * become one of our link fields and its inverse), then formulas, lookups, rollups and counts in
 * rounds (one waits for the fields it reads, across tables), then the grid and kanban views.
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
function problemOf(err: AppError): string {
  const errors = (err.extensions?.['errors'] ?? []) as { message?: string }[];
  return errors[0]?.message ?? err.detail ?? err.message;
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
  const names = new Map(plans.flatMap((p) => p.fields.map((f) => [f.airtableId, f.name])));
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
      copy: true,
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
      if (stored === null)
        return fallback({ b, f }, "It reads a field that wasn't imported as it is in Airtable.");
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
    if (!made.ok) return fallback({ b, f }, problemOf(made.err));
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
      if (p.f.computed && !depsOf(p.f).every((d) => ids.has(d))) {
        await fallback(p, "It reads a field that wasn't imported as it is in Airtable.");
        continue;
      }
      await create(p);
    }
  }
}

/**
 * Airtable's grid views (visible fields in their order) and kanban views (stacked by the
 * table's first single select, or one-person user field). The first grid view takes over the
 * table's default "Grid view". Airtable's API doesn't share filters, sorts or groups; other
 * view types are listed in the report.
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
  const ours = await liveFields(tx, b.table.id);
  const primaryId = ours.find((f) => f.isPrimary)?.id;
  let spare = (await liveViews(tx, b.table.id, ctx.userId)).find((v) => v.type === 'grid');
  for (const v of source.views) {
    const name = v.name.trim().slice(0, 255) || 'View';
    if (v.type !== 'grid' && v.type !== 'kanban') {
      capped(report.unsupportedViews, {
        table: b.plan.name,
        view: name,
        type: v.type,
        message: `${v.type[0]?.toUpperCase() ?? ''}${v.type.slice(1)} views aren't imported: create it again here.`,
      });
      continue;
    }
    let config: UpdateViewInput;
    if (v.type === 'grid') {
      const visible = (v.visibleFieldIds ?? [])
        .map((id) => ids.get(id))
        .filter((id): id is string => id !== undefined);
      config = visible.length
        ? {
            grid: {
              fieldOrder: [...new Set(visible)],
              hiddenFields: ours
                .filter((f) => f.id !== primaryId && !visible.includes(f.id))
                .map((f) => f.id),
            },
          }
        : {};
    } else {
      const stack =
        ours.find((f) => f.type === 'singleSelect') ??
        ours.find(
          (f) =>
            f.type === 'user' &&
            !(parseOptions('user', f.config) as { multiple?: boolean }).multiple
        );
      if (!stack) {
        capped(report.unsupportedViews, {
          table: b.plan.name,
          view: name,
          type: v.type,
          message: 'There is no single select field to stack the cards by.',
        });
        continue;
      }
      config = { kanban: { stackFieldId: stack.id } };
    }
    const reuse = v.type === 'grid' ? spare : undefined;
    if (reuse) spare = undefined;
    const made = await attempt(tx, async (sp) => {
      const sctx = { ...ctx, tx: sp };
      const row = reuse ?? (await createViewRow(sctx, b.table, name, v.type as 'grid' | 'kanban'));
      await updateView(sctx, row, { ...(reuse ? { name } : {}), ...config }, rights);
    });
    if (made.ok) report.views++;
    else {
      capped(report.unsupportedViews, {
        table: b.plan.name,
        view: name,
        type: v.type,
        message: made.message,
      });
    }
  }
}

async function createViewRow(
  ctx: SchemaContext,
  table: TableRow,
  name: string,
  type: 'grid' | 'kanban'
) {
  const view = await createView(ctx, table, { name, type });
  const row = (await liveViews(ctx.tx, table.id, ctx.userId)).find((v) => v.id === view.id);
  if (!row) throw new Error('airtable: the new view is gone');
  return row;
}
