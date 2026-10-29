import {
  type CreateInterfaceInput,
  type CreateInterfacePageInput,
  calendarLayoutFieldRefs,
  filterElementOperator,
  type Interface,
  type InterfacePage,
  type InterfacePageConfig,
  interfaceFormSchema,
  interfacePageConfigSchema,
  isCalendarDateField,
  isInterfaceWritableType,
  kanbanLayoutFieldRefs,
  MAX_INTERFACES_PER_BASE,
  MAX_PAGES_PER_INTERFACE,
  type ProblemFieldError,
  timelineLayoutFieldRefs,
  type UpdateInterfaceInput,
  type UpdateInterfacePageInput,
} from '@openrows/shared';
import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { interfacePages, interfaces, type Transaction, tables, views } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { assertValidSummary, assertValidViewQuery } from '../records/service.js';
import { viewFieldsOf } from '../views/service.js';

/**
 * Interfaces: a base's interfaces and their pages. Editors (creators and up,
 * `base:manage_interfaces`) see every page with its draft; everyone else with a role on the base
 * sees published pages only, and only their published copy: a page never published is a 404 to
 * them, and an interface without a published page isn't listed.
 */

export interface InterfaceContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  userId: string;
}

type InterfaceRow = typeof interfaces.$inferSelect;
type PageRow = typeof interfacePages.$inferSelect;

/** A stored config as the API returns it; a config that no longer parses reads as null. */
function configOf(value: unknown): InterfacePageConfig | null {
  const parsed = interfacePageConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toPage(row: PageRow, canEdit: boolean): InterfacePage {
  const draft = configOf(row.draft);
  const published = row.published === null ? null : configOf(row.published);
  return {
    id: row.id,
    interfaceId: row.interfaceId,
    name: row.name,
    position: row.position,
    draft: canEdit ? draft : null,
    published,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    hasChanges: canEdit && JSON.stringify(draft) !== JSON.stringify(published),
  };
}

function toInterface(row: InterfaceRow, pages: InterfacePage[]): Interface {
  return { id: row.id, baseId: row.baseId, name: row.name, position: row.position, pages };
}

async function pagesOf(tx: Transaction, interfaceIds: string[]): Promise<PageRow[]> {
  if (interfaceIds.length === 0) return [];
  return tx
    .select()
    .from(interfacePages)
    .where(inArray(interfacePages.interfaceId, interfaceIds))
    .orderBy(asc(interfacePages.position), asc(interfacePages.createdAt));
}

/**
 * The base's interfaces in sidebar order (or the one `interfaceId`); non-editors get the
 * published pages only.
 */
export async function listInterfaces(
  tx: Transaction,
  baseId: string,
  canEdit: boolean,
  interfaceId?: string
): Promise<Interface[]> {
  const rows = await tx
    .select()
    .from(interfaces)
    .where(
      and(eq(interfaces.baseId, baseId), interfaceId ? eq(interfaces.id, interfaceId) : undefined)
    )
    .orderBy(asc(interfaces.position), asc(interfaces.createdAt));
  const pages = await pagesOf(
    tx,
    rows.map((r) => r.id)
  );
  return rows
    .map((row) =>
      toInterface(
        row,
        pages
          .filter((p) => p.interfaceId === row.id && (canEdit || p.published !== null))
          .map((p) => toPage(p, canEdit))
      )
    )
    .filter((i) => canEdit || i.pages.length > 0);
}

async function loadInterface(tx: Transaction, baseId: string, id: string): Promise<InterfaceRow> {
  const [row] = await tx
    .select()
    .from(interfaces)
    .where(and(eq(interfaces.id, id), eq(interfaces.baseId, baseId)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such interface in this base.' });
  return row;
}

/** A page of the base's interface; unpublished pages are missing to non-editors. */
export async function loadPage(
  tx: Transaction,
  baseId: string,
  interfaceId: string,
  pageId: string,
  canEdit: boolean
): Promise<PageRow> {
  await loadInterface(tx, baseId, interfaceId);
  const [row] = await tx
    .select()
    .from(interfacePages)
    .where(and(eq(interfacePages.id, pageId), eq(interfacePages.interfaceId, interfaceId)));
  if (!row || (!canEdit && row.published === null)) {
    throw new AppError('NOT_FOUND', { detail: 'No such page in this interface.' });
  }
  return row;
}

export async function createInterface(
  ctx: InterfaceContext,
  input: CreateInterfaceInput
): Promise<Interface> {
  const [stats] = await ctx.tx
    .select({ count: sql<number>`count(*)::int`, last: max(interfaces.position) })
    .from(interfaces)
    .where(eq(interfaces.baseId, ctx.baseId));
  if ((stats?.count ?? 0) >= MAX_INTERFACES_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_INTERFACES_PER_BASE} interfaces.`,
    });
  }
  const [row] = await ctx.tx
    .insert(interfaces)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      name: input.name,
      position: (stats?.last ?? 0) + 1,
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('create interface: no row returned');
  return toInterface(row, []);
}

export async function updateInterface(
  ctx: InterfaceContext,
  id: string,
  input: UpdateInterfaceInput
): Promise<Interface> {
  const row = await loadInterface(ctx.tx, ctx.baseId, id);
  const [updated] = await ctx.tx
    .update(interfaces)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      updatedAt: new Date(),
    })
    .where(eq(interfaces.id, row.id))
    .returning();
  if (!updated) throw new Error('update interface: no row returned');
  const pages = await pagesOf(ctx.tx, [row.id]);
  return toInterface(
    updated,
    pages.map((p) => toPage(p, true))
  );
}

export async function deleteInterface(ctx: InterfaceContext, id: string) {
  const row = await loadInterface(ctx.tx, ctx.baseId, id);
  await ctx.tx.delete(interfaces).where(eq(interfaces.id, row.id));
}

function refuse(errors: ProblemFieldError[]): void {
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The page is invalid.',
      extensions: { errors },
    });
  }
}

/**
 * Refuses (422, paths under `draft`) a page config naming a table that isn't a live table of
 * this base, fields that aren't live fields of it, a filter element on a field that can't be
 * one, a button that clicks something other than a button field that runs automations, or a
 * page filter or sort that wouldn't compile as a view's.
 */
async function checkConfig(ctx: InterfaceContext, config: InterfacePageConfig, path = 'draft') {
  const [table] = await ctx.tx
    .select()
    .from(tables)
    .where(
      and(eq(tables.id, config.tableId), eq(tables.baseId, ctx.baseId), isNull(tables.deletedAt))
    );
  if (!table) {
    refuse([{ path: `${path}.tableId`, message: 'No such table in this base.' }]);
    return;
  }
  const live = (await viewFieldsOf(ctx.tx, table.id)).filter((f) => f.deletedAt === null);
  const byId = new Map(live.map((f) => [f.id, f]));
  const errors: ProblemFieldError[] = [];
  const missing = (p: string) => errors.push({ path: p, message: 'No such field in this table.' });
  for (const [i, id] of config.fields.entries()) {
    if (!byId.has(id)) missing(`${path}.fields.${i}`);
  }
  for (const [i, el] of config.elements.entries()) {
    const at = `${path}.elements.${i}`;
    if (el.type === 'field') {
      if (!byId.has(el.fieldId)) missing(`${at}.fieldId`);
    } else if (el.type === 'filter') {
      const f = byId.get(el.fieldId);
      if (!f) missing(`${at}.fieldId`);
      else if (filterElementOperator(f.type) === null) {
        errors.push({ path: `${at}.fieldId`, message: "This field type can't be a filter." });
      }
    } else if (el.type === 'button' && el.action.type === 'runAutomation') {
      const f = byId.get(el.action.fieldId);
      const options = (f?.options ?? {}) as { action?: string };
      if (f?.type !== 'button' || options.action !== 'runAutomation') {
        errors.push({
          path: `${at}.action.fieldId`,
          message: 'Pick a button field that runs automations.',
        });
      }
    }
  }
  // The view-like layouts' and the form's fields.
  const refs = [
    ...(config.kanban
      ? kanbanLayoutFieldRefs(config.kanban).map((r) => ({ ...r, at: 'kanban' }))
      : []),
    ...(config.calendar
      ? calendarLayoutFieldRefs(config.calendar).map((r) => ({ ...r, at: 'calendar' }))
      : []),
    ...(config.timeline
      ? timelineLayoutFieldRefs(config.timeline).map((r) => ({ ...r, at: 'timeline' }))
      : []),
  ];
  for (const ref of refs) {
    if (!byId.has(ref.id)) missing(`${path}.${ref.at}.${ref.path}`);
  }
  const stack = config.kanban?.stackFieldId ? byId.get(config.kanban.stackFieldId) : undefined;
  if (stack && stack.type !== 'singleSelect') {
    errors.push({
      path: `${path}.kanban.stackFieldId`,
      message: 'Stack by a single select field.',
    });
  }
  for (const [i, d] of (config.calendar?.dateFields ?? []).entries()) {
    const f = byId.get(d.startFieldId);
    if (f && !isCalendarDateField(f)) {
      errors.push({
        path: `${path}.calendar.dateFields.${i}.startFieldId`,
        message: 'Pick a date field.',
      });
    }
  }
  for (const [i, entry] of (config.form?.fields ?? []).entries()) {
    const f = byId.get(entry.fieldId);
    if (!f) missing(`${path}.form.fields.${i}.fieldId`);
    else if (!isInterfaceWritableType(f.type)) {
      errors.push({
        path: `${path}.form.fields.${i}.fieldId`,
        message: "A form page can't ask for this field type.",
      });
    }
  }
  errors.push(...(await dataElementProblems(ctx, config, path)));
  refuse(errors);
  try {
    await assertValidViewQuery(
      { tx: ctx.tx, workspaceId: ctx.workspaceId, userId: ctx.userId, table },
      { filter: config.filter, sorts: config.sorts }
    );
  } catch (err) {
    if (err instanceof AppError && err.code === 'VALIDATION_FAILED') {
      const found = (err.extensions?.['errors'] ?? []) as ProblemFieldError[];
      refuse(found.map((e) => ({ ...e, path: e.path.replace(/^query/, path) })));
    }
    throw err;
  }
}

/**
 * The problems of the page's number and chart elements: a table of this base, a
 * collaborative view of it, and a summary that compiles (fields, aggregates, filter).
 */
async function dataElementProblems(
  ctx: InterfaceContext,
  config: InterfacePageConfig,
  path: string
): Promise<ProblemFieldError[]> {
  const elements = config.elements.flatMap((el, i) =>
    el.type === 'number' || el.type === 'chart' ? [{ el, at: `${path}.elements.${i}` }] : []
  );
  if (elements.length === 0) return [];
  const ids = [...new Set(elements.map((e) => e.el.tableId))];
  const live = await ctx.tx
    .select()
    .from(tables)
    .where(and(inArray(tables.id, ids), eq(tables.baseId, ctx.baseId), isNull(tables.deletedAt)));
  const errors: ProblemFieldError[] = [];
  for (const { el, at } of elements) {
    const table = live.find((t) => t.id === el.tableId);
    if (!table) {
      errors.push({ path: `${at}.tableId`, message: 'No such table in this base.' });
      continue;
    }
    if (el.viewId) {
      const [view] = await ctx.tx
        .select({ id: views.id })
        .from(views)
        .where(
          and(
            eq(views.id, el.viewId),
            eq(views.tableId, table.id),
            eq(views.personal, false),
            isNull(views.deletedAt)
          )
        );
      if (!view) {
        errors.push({ path: `${at}.viewId`, message: 'Pick a collaborative view of this table.' });
        continue;
      }
    }
    try {
      await assertValidSummary(
        { tx: ctx.tx, workspaceId: ctx.workspaceId, userId: ctx.userId, table },
        {
          viewId: el.viewId,
          filters: el.filter ? [{ filter: el.filter, path: 'filter' }] : [],
          fieldId: el.fieldId,
          fn: el.fn,
          ...(el.type === 'chart'
            ? { groupFieldId: el.groupFieldId, seriesFieldId: el.seriesFieldId }
            : {}),
          path: at,
        }
      );
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'VALIDATION_FAILED')) throw err;
      errors.push(...((err.extensions?.['errors'] ?? []) as ProblemFieldError[]));
    }
  }
  return errors;
}

/**
 * A new page's layout settings, from the table's fields: a kanban stacks by its first
 * single select, a calendar and a timeline place records by the first date, a form asks for the
 * first fields a viewer can fill in.
 */
function layoutDefaults(
  layout: InterfacePageConfig['layout'],
  fields: readonly { id: string; type: string; isPrimary: boolean }[]
): Partial<InterfacePageConfig> {
  const date = fields.find((f) => isCalendarDateField(f));
  switch (layout) {
    case 'kanban': {
      const stack = fields.find((f) => f.type === 'singleSelect');
      return { kanban: stack ? { stackFieldId: stack.id } : {} };
    }
    case 'calendar':
      return { calendar: date ? { dateFields: [{ startFieldId: date.id }] } : {} };
    case 'timeline':
      return { timeline: date ? { startFieldId: date.id } : {} };
    case 'form': {
      const writable = [...fields]
        .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
        .filter((f) => isInterfaceWritableType(f.type))
        .slice(0, 10);
      return {
        form: interfaceFormSchema.parse({
          fields: writable.map((f) => ({ fieldId: f.id, required: f.isPrimary })),
        }),
      };
    }
    default:
      return {};
  }
}

/** A new page, unpublished, with an empty layout over the table. */
export async function createPage(
  ctx: InterfaceContext,
  interfaceId: string,
  input: CreateInterfacePageInput
): Promise<InterfacePage> {
  const iface = await loadInterface(ctx.tx, ctx.baseId, interfaceId);
  const [stats] = await ctx.tx
    .select({ count: sql<number>`count(*)::int`, last: max(interfacePages.position) })
    .from(interfacePages)
    .where(eq(interfacePages.interfaceId, iface.id));
  if ((stats?.count ?? 0) >= MAX_PAGES_PER_INTERFACE) {
    throw new AppError('CONFLICT', {
      detail: `An interface can have at most ${MAX_PAGES_PER_INTERFACE} pages.`,
    });
  }
  const live = (await viewFieldsOf(ctx.tx, input.tableId)).filter((f) => f.deletedAt === null);
  const draft = interfacePageConfigSchema.parse({
    layout: input.layout,
    tableId: input.tableId,
    ...layoutDefaults(input.layout, live),
  });
  await checkConfig(ctx, draft);
  const [row] = await ctx.tx
    .insert(interfacePages)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      interfaceId: iface.id,
      name: input.name,
      position: (stats?.last ?? 0) + 1,
      draft,
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('create interface page: no row returned');
  return toPage(row, true);
}

export async function updatePage(
  ctx: InterfaceContext,
  interfaceId: string,
  pageId: string,
  input: UpdateInterfacePageInput
): Promise<InterfacePage> {
  const row = await loadPage(ctx.tx, ctx.baseId, interfaceId, pageId, true);
  if (input.draft) await checkConfig(ctx, input.draft);
  const [updated] = await ctx.tx
    .update(interfacePages)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.draft !== undefined ? { draft: input.draft } : {}),
      updatedAt: new Date(),
    })
    .where(eq(interfacePages.id, row.id))
    .returning();
  if (!updated) throw new Error('update interface page: no row returned');
  return toPage(updated, true);
}

export async function deletePage(ctx: InterfaceContext, interfaceId: string, pageId: string) {
  const row = await loadPage(ctx.tx, ctx.baseId, interfaceId, pageId, true);
  await ctx.tx.delete(interfacePages).where(eq(interfacePages.id, row.id));
}

/** Publishes the draft as it is now, checked again against the base (fields may have gone). */
export async function publishPage(
  ctx: InterfaceContext,
  interfaceId: string,
  pageId: string
): Promise<InterfacePage> {
  const row = await loadPage(ctx.tx, ctx.baseId, interfaceId, pageId, true);
  const draft = configOf(row.draft);
  if (!draft) {
    refuse([{ path: 'draft', message: 'The draft is invalid; save it again first.' }]);
    return toPage(row, true);
  }
  await checkConfig(ctx, draft);
  const [updated] = await ctx.tx
    .update(interfacePages)
    .set({ published: draft, publishedAt: new Date(), publishedBy: ctx.userId })
    .where(eq(interfacePages.id, row.id))
    .returning();
  if (!updated) throw new Error('publish interface page: no row returned');
  return toPage(updated, true);
}

export async function unpublishPage(
  ctx: InterfaceContext,
  interfaceId: string,
  pageId: string
): Promise<InterfacePage> {
  const row = await loadPage(ctx.tx, ctx.baseId, interfaceId, pageId, true);
  const [updated] = await ctx.tx
    .update(interfacePages)
    .set({ published: null, publishedAt: null, publishedBy: null })
    .where(eq(interfacePages.id, row.id))
    .returning();
  if (!updated) throw new Error('unpublish interface page: no row returned');
  return toPage(updated, true);
}
