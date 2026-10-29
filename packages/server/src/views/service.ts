import {
  type CalendarLayout,
  type CreateViewInput,
  calendarLayoutFieldRefs,
  calendarLayoutOf,
  createViewSchema,
  type DuplicateViewInput,
  type FormLayout,
  fitsTimelineKey,
  formLayoutOf,
  formLayoutProblems,
  type GalleryLayout,
  type GridLayout,
  galleryLayoutFieldRefs,
  galleryLayoutOf,
  gridLayoutFieldRefs,
  gridLayoutOf,
  isCalendarDateField,
  isFormFieldType,
  isInlineImageType,
  isSelfLinkField,
  isStackableField,
  type KanbanLayout,
  kanbanLayoutFieldRefs,
  kanbanLayoutOf,
  type ListLayout,
  listLayoutFieldRefs,
  listLayoutOf,
  MAX_FORM_FIELDS,
  type MoveViewRecordInput,
  type ProblemFieldError,
  type RowColor,
  type TIMELINE_FIELD_KEYS,
  type TimelineLayout,
  timelineLayoutFieldRefs,
  timelineLayoutOf,
  type UpdateViewInput,
  ViewSchema,
  viewConfigOf,
} from '@openrows/shared';
import { and, asc, eq, inArray, isNotNull, isNull, max, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { qualified } from '../data/columns.js';
import { emit } from '../data/outbox.js';
import { POSITION_GAP } from '../data/positions.js';
import {
  attachments,
  fields,
  type Transaction,
  tables,
  viewRecordPositions,
  viewSections,
  views,
} from '../db/index.js';
import type { SchemaContext, TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { assertValidViewQuery, filterProblems } from '../records/service.js';
import { loadTable } from '../tables/service.js';
import { visibleTo } from './visibility.js';

/** Airtable's cap on views per table. */
export const MAX_VIEWS_PER_TABLE = 1000;

export type ViewRow = typeof views.$inferSelect;

/** What a view's config is checked and pruned against: a table's fields. */
export type ViewField = {
  id: string;
  type: string;
  isPrimary: boolean;
  options: unknown;
  deletedAt: Date | null;
};

/** The fields of a table, trashed ones included (`deletedAt`). */
export async function viewFieldsOf(tx: Transaction, tableId: string): Promise<ViewField[]> {
  const rows = await tx.select().from(fields).where(eq(fields.tableId, tableId));
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    isPrimary: row.isPrimary,
    options: row.config,
    deletedAt: row.deletedAt,
  }));
}

/**
 * A view as the API returns it. The config is typed and pruned of the fields that aren't live
 * in the table; the stored config keeps them, so a restored field gets its settings back.
 */
export function toView(row: ViewRow, tableFields: readonly ViewField[]) {
  const live = tableFields.filter((f) => f.deletedAt === null);
  return ViewSchema.parse({
    id: row.id,
    tableId: row.tableId,
    name: row.name,
    type: row.type,
    position: row.position,
    config: viewConfigOf((row.config ?? {}) as Record<string, unknown>, live),
    personal: row.personal,
    locked: row.locked,
    sectionId: row.sectionId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** The live views of a table that `userId` may see, in sidebar order. */
export async function liveViews(
  tx: Transaction,
  tableId: string,
  userId: string
): Promise<ViewRow[]> {
  return tx
    .select()
    .from(views)
    .where(and(eq(views.tableId, tableId), isNull(views.deletedAt), visibleTo(userId)))
    .orderBy(asc(views.position), asc(views.createdAt));
}

/** The authorized view of a request. */
export async function loadView(tx: Transaction, id: string): Promise<ViewRow> {
  const [row] = await tx.select().from(views).where(eq(views.id, id));
  if (!row) throw new Error('view not visible under RLS');
  return row;
}

async function baseIdOf(tx: Transaction, tableId: string): Promise<string> {
  const [row] = await tx
    .select({ baseId: tables.baseId })
    .from(tables)
    .where(eq(tables.id, tableId));
  if (!row) throw new Error('view without a visible table');
  return row.baseId;
}

/**
 * Names are unique among the views a user sees, so another user's personal view never blocks
 * (or reveals) a name.
 */
async function assertNameFree(ctx: SchemaContext, tableId: string, name: string, except?: string) {
  const [clash] = await ctx.tx
    .select({ id: views.id })
    .from(views)
    .where(
      and(
        eq(views.tableId, tableId),
        isNull(views.deletedAt),
        visibleTo(ctx.userId),
        sql`lower(${views.name}) = lower(${name})`,
        except ? ne(views.id, except) : undefined
      )
    )
    .limit(1);
  if (clash) throw new AppError('CONFLICT', { detail: `A view named "${name}" already exists.` });
}

/** A name not taken in the table: `name`, `name 2`, `name 3`… */
async function freeName(ctx: SchemaContext, tableId: string, name: string): Promise<string> {
  const taken = new Set(
    (await liveViews(ctx.tx, tableId, ctx.userId)).map((v) => v.name.toLowerCase())
  );
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} ${n}`;
  return candidate;
}

async function insertView(
  ctx: SchemaContext,
  tableId: string,
  values: {
    name: string;
    type: string;
    config: unknown;
    personal: boolean;
    sectionId?: string | null;
  }
): Promise<ViewRow> {
  const { tx } = ctx;
  const [stats] = await tx
    .select({ count: sql<number>`count(*)::int`, last: max(views.position) })
    .from(views)
    .where(and(eq(views.tableId, tableId), isNull(views.deletedAt)));
  if ((stats?.count ?? 0) >= MAX_VIEWS_PER_TABLE) {
    throw new AppError('CONFLICT', {
      detail: `A table can have at most ${MAX_VIEWS_PER_TABLE} views.`,
    });
  }
  await assertNameFree(ctx, tableId, values.name);
  const [row] = await tx
    .insert(views)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      tableId,
      name: values.name,
      type: values.type,
      config: values.config,
      personal: values.personal,
      sectionId: values.sectionId ?? null,
      position: (stats?.last ?? 0) + 1,
      createdBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('create view: no row returned');
  return row;
}

async function emitView(
  ctx: SchemaContext,
  kind: 'view.created' | 'view.updated' | 'view.deleted' | 'view.restored' | 'view.recordMoved',
  row: ViewRow,
  payload: Record<string, unknown>
) {
  await emit(ctx.tx, {
    workspaceId: ctx.workspaceId,
    baseId: await baseIdOf(ctx.tx, row.tableId),
    tableId: row.tableId,
    kind,
    // A personal view's events go to its owner only (realtime/projection.ts strips this).
    payload: { ...payload, personalTo: row.personal ? (row.createdBy ?? '') : null },
    actorId: ctx.userId,
  });
}

/**
 * Refuses (422, with paths under `grid`) a layout naming fields that aren't this table's. A
 * field of this table in the trash is accepted (a client may not have seen the delete yet) and
 * pruned on read.
 */
function assertValidGridLayout(layout: GridLayout, tableFields: readonly ViewField[]) {
  const ids = new Set(tableFields.map((f) => f.id));
  const primary = tableFields.find((f) => f.isPrimary && f.deletedAt === null)?.id;
  const errors: ProblemFieldError[] = gridLayoutFieldRefs(layout).flatMap(({ path, id }) =>
    ids.has(id) ? [] : [{ path: `grid.${path}`, message: 'No such field in this table.' }]
  );
  (layout.hiddenFields ?? []).forEach((id, i) => {
    if (id === primary) {
      errors.push({
        path: `grid.hiddenFields.${i}`,
        message: "The primary field can't be hidden.",
      });
    }
  });
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The grid layout is invalid.',
      extensions: { errors },
    });
  }
}

/**
 * Refuses (422, with paths under `kanban`) a kanban layout naming fields that aren't this
 * table's, a stack field that isn't a single select or one-person user field, or a cover field
 * that isn't an attachment field.
 */
function assertValidKanbanLayout(layout: KanbanLayout, tableFields: readonly ViewField[]) {
  const byId = new Map(tableFields.map((f) => [f.id, f]));
  const errors: ProblemFieldError[] = kanbanLayoutFieldRefs(layout).flatMap(({ path, id }) =>
    byId.has(id) ? [] : [{ path: `kanban.${path}`, message: 'No such field in this table.' }]
  );
  const stack = layout.stackFieldId ? byId.get(layout.stackFieldId) : undefined;
  if (stack && !isStackableField(stack)) {
    errors.push({
      path: 'kanban.stackFieldId',
      message: 'Stack by a single select or a user field with one person per record.',
    });
  }
  const cover = layout.coverFieldId ? byId.get(layout.coverFieldId) : undefined;
  if (cover && cover.type !== 'attachment') {
    errors.push({ path: 'kanban.coverFieldId', message: 'The cover must be an attachment field.' });
  }
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The kanban layout is invalid.',
      extensions: { errors },
    });
  }
}

/**
 * Refuses (422, with paths under `calendar`) a calendar layout naming fields that aren't this
 * table's, date field pairs of fields that aren't dates, or a colour field that isn't a single
 * select.
 */
function assertValidCalendarLayout(layout: CalendarLayout, tableFields: readonly ViewField[]) {
  const byId = new Map(tableFields.map((f) => [f.id, f]));
  const errors: ProblemFieldError[] = calendarLayoutFieldRefs(layout).flatMap(({ path, id }) => {
    const f = byId.get(id);
    if (!f) return [{ path: `calendar.${path}`, message: 'No such field in this table.' }];
    if (path.startsWith('dateFields.') && !isCalendarDateField(f)) {
      return [{ path: `calendar.${path}`, message: 'Pick a date or date and time field.' }];
    }
    if (path === 'colorFieldId' && f.type !== 'singleSelect') {
      return [{ path: `calendar.${path}`, message: 'Colour by a single select field.' }];
    }
    return [];
  });
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The calendar layout is invalid.',
      extensions: { errors },
    });
  }
}

function refuseLayout(kind: string, errors: ProblemFieldError[]) {
  if (errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `The ${kind} layout is invalid.`,
      extensions: { errors },
    });
  }
}

/**
 * Refuses (422, with paths under `gallery`) a gallery layout naming fields that aren't this
 * table's, or a cover field that isn't an attachment field.
 */
function assertValidGalleryLayout(layout: GalleryLayout, tableFields: readonly ViewField[]) {
  const byId = new Map(tableFields.map((f) => [f.id, f]));
  const errors: ProblemFieldError[] = galleryLayoutFieldRefs(layout).flatMap(({ path, id }) => {
    const f = byId.get(id);
    if (!f) return [{ path: `gallery.${path}`, message: 'No such field in this table.' }];
    if (path === 'coverFieldId' && f.type !== 'attachment') {
      return [{ path: `gallery.${path}`, message: 'The cover must be an attachment field.' }];
    }
    return [];
  });
  refuseLayout('gallery', errors);
}

const TIMELINE_KEY_MESSAGES: Record<(typeof TIMELINE_FIELD_KEYS)[number], string> = {
  startFieldId: 'Pick a date or date and time field.',
  endFieldId: 'Pick a date or date and time field.',
  groupFieldId: 'Group by a single select field.',
  colorFieldId: 'Colour by a single select field.',
  dependencyFieldId: 'Dependencies need a link to records of this table.',
};

/**
 * Refuses (422, with paths under `timeline`) a timeline layout naming fields that aren't this
 * table's or don't fit their key: dates for start and end, single selects to group and colour
 * by, a link to the same table for dependencies.
 */
function assertValidTimelineLayout(
  layout: TimelineLayout,
  tableFields: readonly ViewField[],
  tableId: string
) {
  const byId = new Map(tableFields.map((f) => [f.id, f]));
  const errors: ProblemFieldError[] = timelineLayoutFieldRefs(layout).flatMap(({ path, id }) => {
    const f = byId.get(id);
    if (!f) return [{ path: `timeline.${path}`, message: 'No such field in this table.' }];
    const key = path as (typeof TIMELINE_FIELD_KEYS)[number];
    return fitsTimelineKey(key, f, tableId)
      ? []
      : [{ path: `timeline.${path}`, message: TIMELINE_KEY_MESSAGES[key] }];
  });
  refuseLayout('timeline', errors);
}

/**
 * Refuses (422, with paths under `list`) a list layout naming fields that aren't this table's,
 * or a parent field that isn't a link to records of this table.
 */
function assertValidListLayout(
  layout: ListLayout,
  tableFields: readonly ViewField[],
  tableId: string
) {
  const byId = new Map(tableFields.map((f) => [f.id, f]));
  const errors: ProblemFieldError[] = listLayoutFieldRefs(layout).flatMap(({ path, id }) => {
    const f = byId.get(id);
    if (!f) return [{ path: `list.${path}`, message: 'No such field in this table.' }];
    if (path === 'parentFieldId' && !isSelfLinkField(f, tableId)) {
      return [{ path: `list.${path}`, message: 'Nest by a link to records of this table.' }];
    }
    return [];
  });
  refuseLayout('list', errors);
}

/**
 * Refuses (422, under `rowColor`) colouring by a field that isn't a single select of this table,
 * or conditions whose filters wouldn't compile as a view's filter would.
 */
async function assertValidRowColor(
  ctx: SchemaContext,
  tableId: string,
  rowColor: RowColor,
  tableFields: readonly ViewField[]
) {
  if (rowColor.mode === 'select') {
    const f = tableFields.find((x) => x.id === rowColor.fieldId);
    if (!f) {
      refuseLayout('row colour', [
        { path: 'rowColor.fieldId', message: 'No such field in this table.' },
      ]);
    } else if (f.type !== 'singleSelect') {
      refuseLayout('row colour', [
        { path: 'rowColor.fieldId', message: 'Colour by a single select field.' },
      ]);
    }
    return;
  }
  const table = await loadTable(ctx.tx, tableId);
  for (const [i, c] of rowColor.conditions.entries()) {
    try {
      await assertValidViewQuery({ ...ctx, table }, { filter: c.filter });
    } catch (err) {
      if (err instanceof AppError && err.code === 'VALIDATION_FAILED') {
        const errors = (err.extensions?.['errors'] ?? []) as ProblemFieldError[];
        refuseLayout(
          'row colour',
          errors.map((e) => ({
            ...e,
            path: e.path.replace(/^query\.filter/, `rowColor.conditions.${i}.filter`),
          }))
        );
      }
      throw err;
    }
  }
}

/**
 * Refuses (422, with paths under `form`) a form layout on a view that isn't a form, or one
 * naming fields that aren't live fields of this table or can't be on a form (computed,
 * automatic, buttons), the same field twice, conditions on fields that aren't above the field
 * on the form or that wouldn't compile as a view's filter would, a redirect that isn't
 * `https:` or has no URL, and a cover or logo that isn't a ready image uploaded for a form view
 * of this table. Only the keys of the patch are checked: a stored layout naming a field
 * deleted since stays (it's pruned on read).
 */
async function assertValidFormLayout(
  ctx: SchemaContext,
  row: ViewRow,
  patch: FormLayout,
  tableFields: readonly ViewField[]
) {
  if (row.type !== 'form') {
    refuseLayout('form', [{ path: 'form', message: 'Only a form view has a form layout.' }]);
  }
  const live = tableFields.filter((f) => f.deletedAt === null);
  const stored = formLayoutOf((row.config ?? {}) as Record<string, unknown>);
  const afterSubmit = patch.afterSubmit ?? stored.afterSubmit;
  const redirectUrl = patch.redirectUrl !== undefined ? patch.redirectUrl : stored.redirectUrl;
  const errors = formLayoutProblems(
    {
      ...(patch.fields ? { fields: patch.fields } : {}),
      ...(afterSubmit ? { afterSubmit } : {}),
      ...(redirectUrl ? { redirectUrl } : {}),
    },
    live
  ).map((e) => ({ path: `form.${e.path}`, message: e.message }));
  if (errors.length === 0 && patch.fields?.some((f) => f.condition)) {
    const table = await loadTable(ctx.tx, row.tableId);
    const conditioned = patch.fields.flatMap((f, i) =>
      f.condition ? [{ i, f: f.condition }] : []
    );
    const found = await filterProblems(
      { ...ctx, table },
      conditioned.map((c) => c.f)
    );
    conditioned.forEach(({ i }, k) => {
      for (const e of found[k] ?? []) {
        errors.push({
          ...e,
          path: e.path.replace(/^query\.filter/, `form.fields.${i}.condition`),
        });
      }
    });
  }
  // A link field's picker view: a shared (not personal), live, non-form view of the
  // linked table, since the public form lists its records' primary field to anyone.
  const pickers = (patch.fields ?? []).flatMap((entry, i) => {
    const viewId = entry.viewIdForRecordSelection;
    const field = live.find((f) => f.id === entry.fieldId);
    if (!viewId || field?.type !== 'link') return [];
    const linked = (field.options as { linkedTableId?: unknown } | null)?.linkedTableId;
    return [{ i, viewId, tableId: typeof linked === 'string' ? linked : null }];
  });
  if (errors.length === 0 && pickers.length > 0) {
    const found = await ctx.tx
      .select({ id: views.id, tableId: views.tableId })
      .from(views)
      .where(
        and(
          inArray(
            views.id,
            pickers.map((p) => p.viewId)
          ),
          isNull(views.deletedAt),
          eq(views.personal, false),
          sql`${views.type} <> 'form'`
        )
      );
    for (const { i, viewId, tableId } of pickers) {
      if (!found.some((v) => v.id === viewId && v.tableId === tableId)) {
        errors.push({
          path: `form.fields.${i}.viewIdForRecordSelection`,
          message: 'Pick a collaborative view of the linked table.',
        });
      }
    }
  }
  const images = (['coverAttachmentId', 'logoAttachmentId'] as const).flatMap((key) => {
    const id = patch[key];
    return id ? [{ key, id }] : [];
  });
  if (images.length > 0) {
    const ready = await ctx.tx
      .select({ id: attachments.id, contentType: attachments.contentType })
      .from(attachments)
      .where(
        and(
          inArray(
            attachments.id,
            images.map((i) => i.id)
          ),
          eq(attachments.tableId, row.tableId),
          isNotNull(attachments.viewId),
          eq(attachments.status, 'ready')
        )
      );
    for (const { key, id } of images) {
      const file = ready.find((r) => r.id === id);
      if (!file || !isInlineImageType(file.contentType)) {
        errors.push({ path: `form.${key}`, message: 'Upload an image for this form first.' });
      }
    }
  }
  refuseLayout('form', errors);
}

async function assertSectionOfTable(tx: Transaction, tableId: string, sectionId: string) {
  const [section] = await tx
    .select({ id: viewSections.id })
    .from(viewSections)
    .where(and(eq(viewSections.id, sectionId), eq(viewSections.tableId, tableId)));
  if (!section) {
    refuseLayout('view', [{ path: 'sectionId', message: 'No such section in this table.' }]);
  }
}

/** What the requester may do to a view beyond `view:update`. */
export interface ViewRights {
  /** `view:lock`: lock and unlock, and change a locked view's configuration. */
  canLock: boolean;
}

function assertUnlocked(row: ViewRow, rights: ViewRights) {
  if (row.locked && !rights.canLock) {
    throw new AppError('FORBIDDEN', {
      detail: 'This view is locked. Only creators and owners can change it.',
    });
  }
}

/** Collaborative views of a table other than `except`: a table keeps at least one. */
async function otherCollaborativeViews(tx: Transaction, tableId: string, except: string) {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(views)
    .where(
      and(
        eq(views.tableId, tableId),
        isNull(views.deletedAt),
        eq(views.personal, false),
        ne(views.id, except)
      )
    );
  return row?.count ?? 0;
}

/**
 * A new form's layout: every live field a form can hold, in the table's field order,
 * the primary field first.
 */
async function newFormLayout(tx: Transaction, tableId: string): Promise<FormLayout> {
  const rows = await tx
    .select({ id: fields.id, type: fields.type })
    .from(fields)
    .where(and(eq(fields.tableId, tableId), isNull(fields.deletedAt)))
    .orderBy(sql`${fields.isPrimary} DESC`, asc(fields.position), asc(fields.createdAt));
  return {
    fields: rows
      .filter((f) => isFormFieldType(f.type))
      .slice(0, MAX_FORM_FIELDS)
      .map((f) => ({ fieldId: f.id })),
  };
}

/** Adds a view at the end of the table's view list (a form starts with every writable field). */
export async function createView(ctx: SchemaContext, table: TableRow, input: CreateViewInput) {
  const { name, type, personal } = createViewSchema.parse(input);
  const config = type === 'form' ? { form: await newFormLayout(ctx.tx, table.id) } : {};
  const row = await insertView(ctx, table.id, { name, type, config, personal });
  const view = toView(row, await viewFieldsOf(ctx.tx, table.id));
  await emitView(ctx, 'view.created', row, { view });
  return view;
}

/**
 * Changes a view. A locked view's name and configuration (layouts, row colour, query) change
 * only with `rights.canLock` (403 otherwise), which locking and unlocking also need; its place
 * in the sidebar (position, section) is anyone's with `view:update`. Only the view's creator
 * turns it personal or collaborative, and a table keeps one collaborative view.
 */
export async function updateView(
  ctx: SchemaContext,
  row: ViewRow,
  input: UpdateViewInput,
  rights: ViewRights
) {
  const { position, sectionId, personal, locked, ...configKeys } = input;
  if (Object.values(configKeys).some((v) => v !== undefined)) assertUnlocked(row, rights);
  if (locked !== undefined && locked !== row.locked && !rights.canLock) {
    throw new AppError('FORBIDDEN', { detail: 'Only creators and owners can lock a view.' });
  }
  if (personal !== undefined && personal !== row.personal) {
    if (row.createdBy !== ctx.userId) {
      throw new AppError('FORBIDDEN', {
        detail: 'Only the person who created a view can make it personal or collaborative.',
      });
    }
    if (personal && (await otherCollaborativeViews(ctx.tx, row.tableId, row.id)) === 0) {
      throw new AppError('CONFLICT', { detail: 'A table needs at least one collaborative view.' });
    }
  }
  if (sectionId) await assertSectionOfTable(ctx.tx, row.tableId, sectionId);
  if (input.name !== undefined) await assertNameFree(ctx, row.tableId, input.name, row.id);
  const tableFields = await viewFieldsOf(ctx.tx, row.tableId);
  const changes: Partial<ViewRow> = {};
  if (input.name !== undefined) changes.name = input.name;
  if (position !== undefined) changes.position = position;
  if (sectionId !== undefined) changes.sectionId = sectionId;
  if (personal !== undefined) changes.personal = personal;
  if (locked !== undefined) changes.locked = locked;
  let config = (row.config ?? {}) as Record<string, unknown>;
  if (input.grid !== undefined) {
    assertValidGridLayout(input.grid, tableFields);
    config = { ...config, grid: { ...gridLayoutOf(config), ...input.grid } };
    changes.config = config;
  }
  if (input.kanban !== undefined) {
    assertValidKanbanLayout(input.kanban, tableFields);
    config = { ...config, kanban: { ...kanbanLayoutOf(config), ...input.kanban } };
    changes.config = config;
  }
  if (input.calendar !== undefined) {
    assertValidCalendarLayout(input.calendar, tableFields);
    config = { ...config, calendar: { ...calendarLayoutOf(config), ...input.calendar } };
    changes.config = config;
  }
  if (input.gallery !== undefined) {
    assertValidGalleryLayout(input.gallery, tableFields);
    config = { ...config, gallery: { ...galleryLayoutOf(config), ...input.gallery } };
    changes.config = config;
  }
  if (input.timeline !== undefined) {
    assertValidTimelineLayout(input.timeline, tableFields, row.tableId);
    config = { ...config, timeline: { ...timelineLayoutOf(config), ...input.timeline } };
    changes.config = config;
  }
  if (input.list !== undefined) {
    assertValidListLayout(input.list, tableFields, row.tableId);
    config = { ...config, list: { ...listLayoutOf(config), ...input.list } };
    changes.config = config;
  }
  if (input.form !== undefined) {
    await assertValidFormLayout(ctx, row, input.form, tableFields);
    config = { ...config, form: { ...formLayoutOf(config), ...input.form } };
    changes.config = config;
  }
  if (input.rowColor !== undefined) {
    if (input.rowColor) await assertValidRowColor(ctx, row.tableId, input.rowColor, tableFields);
    config = { ...config, rowColor: input.rowColor };
    changes.config = config;
  }
  if (input.query !== undefined) {
    const table = await loadTable(ctx.tx, row.tableId);
    await assertValidViewQuery({ ...ctx, table }, input.query);
    config = { ...config, ...input.query };
    changes.config = config;
  }
  if (Object.keys(changes).length === 0) return toView(row, tableFields);
  const [updated] = await ctx.tx
    .update(views)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(views.id, row.id))
    .returning();
  if (!updated) throw new Error('update view: no row returned');
  const view = toView(updated, tableFields);
  await emitView(ctx, 'view.updated', updated, { view });
  return view;
}

/**
 * Copies the view's type, config and section under a free name ("<name> copy"), at the end of
 * the list. The copy is unlocked, and personal (the requester's) when the view was.
 */
export async function duplicateView(ctx: SchemaContext, row: ViewRow, input: DuplicateViewInput) {
  const name = await freeName(ctx, row.tableId, input.name ?? `${row.name} copy`);
  const copy = await insertView(ctx, row.tableId, {
    name,
    type: row.type,
    config: row.config,
    personal: row.personal,
    sectionId: row.sectionId,
  });
  // The copy keeps the manual card order.
  await ctx.tx.execute(sql`
    INSERT INTO ${viewRecordPositions} (workspace_id, view_id, record_id, position)
    SELECT workspace_id, ${copy.id}, record_id, position
      FROM ${viewRecordPositions} WHERE view_id = ${row.id}`);
  const view = toView(copy, await viewFieldsOf(ctx.tx, row.tableId));
  await emitView(ctx, 'view.created', copy, { view, duplicatedFrom: row.id });
  return view;
}

/**
 * Soft-deletes a view (a locked one only with `rights.canLock`). A table keeps at least one
 * collaborative view, as in Airtable.
 */
export async function deleteView(ctx: SchemaContext, row: ViewRow, rights: ViewRights) {
  assertUnlocked(row, rights);
  if (!row.personal && (await otherCollaborativeViews(ctx.tx, row.tableId, row.id)) === 0) {
    throw new AppError('CONFLICT', { detail: 'A table needs at least one view.' });
  }
  await ctx.tx
    .update(views)
    .set({ deletedAt: new Date(), deletedBy: ctx.userId })
    .where(eq(views.id, row.id));
  await emitView(ctx, 'view.deleted', row, { viewId: row.id });
}

/**
 * A view of the table in the trash that the requester may see (someone else's personal view is
 * no view at all), or 404.
 */
async function trashedView(ctx: SchemaContext, tableId: string, id: string): Promise<ViewRow> {
  const [row] = await ctx.tx
    .select()
    .from(views)
    .where(
      and(
        eq(views.id, id),
        eq(views.tableId, tableId),
        isNotNull(views.deletedAt),
        visibleTo(ctx.userId)
      )
    );
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such view in the trash.' });
  return row;
}

/**
 * Brings a view back from the trash under its name (409 if taken), at its old place; a
 * locked view only with `rights.canLock`, as deleting it.
 */
export async function restoreView(
  ctx: SchemaContext,
  tableId: string,
  id: string,
  rights: ViewRights
) {
  const row = await trashedView(ctx, tableId, id);
  assertUnlocked(row, rights);
  await assertNameFree(ctx, tableId, row.name);
  const [stats] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(views)
    .where(and(eq(views.tableId, tableId), isNull(views.deletedAt)));
  if ((stats?.count ?? 0) >= MAX_VIEWS_PER_TABLE) {
    throw new AppError('CONFLICT', {
      detail: `A table can have at most ${MAX_VIEWS_PER_TABLE} views.`,
    });
  }
  const [restored] = await ctx.tx
    .update(views)
    .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
    .where(eq(views.id, row.id))
    .returning();
  if (!restored) throw new Error('restore view: no row returned');
  const view = toView(restored, await viewFieldsOf(ctx.tx, tableId));
  await emitView(ctx, 'view.restored', restored, { view });
  return view;
}

/** Deletes a view in the trash for good, with its record order and share links. */
export async function purgeView(
  ctx: SchemaContext,
  tableId: string,
  id: string,
  rights: ViewRights
) {
  const row = await trashedView(ctx, tableId, id);
  assertUnlocked(row, rights);
  await ctx.tx.delete(views).where(eq(views.id, row.id));
}

async function positionOf(tx: Transaction, viewId: string, recordId: string) {
  const [row] = await tx
    .select({ position: viewRecordPositions.position })
    .from(viewRecordPositions)
    .where(and(eq(viewRecordPositions.viewId, viewId), eq(viewRecordPositions.recordId, recordId)));
  return row?.position ?? null;
}

/**
 * Where a record goes to sit right after `afterId` (`null`: first) in the view's order, or `null`
 * when there's no room: `afterId` has no position yet, or the gap to the next one is used up.
 */
async function positionAfter(
  tx: Transaction,
  viewId: string,
  recordId: string,
  afterId: string | null
): Promise<number | null> {
  const others = and(
    eq(viewRecordPositions.viewId, viewId),
    ne(viewRecordPositions.recordId, recordId)
  );
  if (afterId === null) {
    const [first] = await tx
      .select({ min: sql<number | null>`min(${viewRecordPositions.position})` })
      .from(viewRecordPositions)
      .where(others);
    return first?.min === null || first?.min === undefined ? 0 : first.min - POSITION_GAP;
  }
  const after = await positionOf(tx, viewId, afterId);
  if (after === null) return null;
  const [next] = await tx
    .select({ min: sql<number | null>`min(${viewRecordPositions.position})` })
    .from(viewRecordPositions)
    .where(and(others, sql`${viewRecordPositions.position} > ${after}`));
  if (next?.min === null || next?.min === undefined) return after + POSITION_GAP;
  const mid = (after + next.min) / 2;
  return mid > after && mid < next.min ? mid : null;
}

/**
 * Numbers every live record of the view's table in its current manual order (1024, 2048, …):
 * the positioned ones first, then the rest oldest first. One statement, run when a move finds
 * no room.
 */
async function renumber(ctx: SchemaContext, viewId: string, table: TableRow) {
  await ctx.tx.execute(sql`
    INSERT INTO ${viewRecordPositions} (workspace_id, view_id, record_id, position)
    SELECT ${ctx.workspaceId}, ${viewId}, r.id,
           (row_number() OVER (ORDER BY p.position ASC NULLS LAST, r.id)) * ${POSITION_GAP}
      FROM ${qualified(table)} AS r
      LEFT JOIN ${viewRecordPositions} AS p ON p.view_id = ${viewId} AND p.record_id = r.id
     WHERE r.deleted_at IS NULL
    ON CONFLICT (view_id, record_id) DO UPDATE SET position = excluded.position`);
}

/**
 * Puts a record right after `afterId` (`null`: first) in the view's manual order. Both
 * must be live records of the view's table (404 otherwise). Moves of one view run one at a time
 * (the view row is locked).
 */
export async function moveViewRecord(
  ctx: SchemaContext,
  row: ViewRow,
  input: MoveViewRecordInput,
  rights: ViewRights
) {
  // The manual order is part of the view's configuration.
  assertUnlocked(row, rights);
  const table = await loadTable(ctx.tx, row.tableId);
  const ids = input.afterId ? [input.recordId, input.afterId] : [input.recordId];
  const { rows: found } = await ctx.tx.execute<{ id: string }>(sql`
    SELECT id FROM ${qualified(table)}
     WHERE id IN (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `
     )}) AND deleted_at IS NULL`);
  if (found.length !== ids.length) {
    throw new AppError('NOT_FOUND', { detail: 'No such record in this table.' });
  }
  await ctx.tx.execute(sql`SELECT 1 FROM ${views} WHERE id = ${row.id} FOR UPDATE`);
  let position = await positionAfter(ctx.tx, row.id, input.recordId, input.afterId);
  if (position === null) {
    await renumber(ctx, row.id, table);
    position = await positionAfter(ctx.tx, row.id, input.recordId, input.afterId);
  }
  if (position === null) throw new Error('move view record: no position after renumbering');
  await ctx.tx
    .insert(viewRecordPositions)
    .values({ workspaceId: ctx.workspaceId, viewId: row.id, recordId: input.recordId, position })
    .onConflictDoUpdate({
      target: [viewRecordPositions.viewId, viewRecordPositions.recordId],
      set: { position },
    });
  await emitView(ctx, 'view.recordMoved', row, {
    viewId: row.id,
    recordId: input.recordId,
    afterId: input.afterId,
  });
}
