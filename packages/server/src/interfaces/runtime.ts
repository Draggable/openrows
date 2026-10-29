import {
  filterElementConditions,
  gridLayoutOf,
  type InterfaceAccess,
  type InterfacePageConfig,
  type InterfacePageRecords,
  isInterfaceWritableType,
  pruneViewQuery,
  publicFieldOptions,
  roleAllows,
  type SharedViewShape,
  sharedViewShape,
  type UserRole,
  VIEW_LIKE_LAYOUTS,
  viewQuerySchema,
} from '@openrows/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { compileViewQuery } from '../data/query/compile.js';
import { recordMatches } from '../data/query/execute.js';
import { bases, interfaces, type Transaction, tables } from '../db/index.js';
import type { Entitlements } from '../edition/types.js';
import { fieldType, type TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import type { FieldVisibility } from '../realtime/projection.js';
import {
  createRecords,
  type FieldInfo,
  type SharedViewQuery,
  sharedRecords,
  tableFields,
  toQueryFields,
  updateRecords,
} from '../records/service.js';
import { listInterfaces } from './service.js';

/**
 * The interface runtime: what a page's viewer reads and writes through the page, never
 * through the base's API. Its records come projected like a share link's (`sharedRecords`): only
 * the fields the page shows, links and people as names, the page filter applied on the server
 * with `me` as the viewer. Writes go through the RecordService with the viewer's role, limited
 * to what the page offers: a record review's editable field elements on a record the page lists,
 * and a form page's fields. Interface-only collaborators reach nothing else.
 */

export interface PageContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  userId: string;
  /** The viewer's effective role on the interface. */
  role: UserRole;
  visibility: FieldVisibility;
}

/** One interface as its viewer reaches it, with the pages they may see. */
export async function interfaceAccess(
  tx: Transaction,
  resource: { id: string; workspaceId: string; baseId: string; role: UserRole },
  interfaceOnly: boolean
): Promise<InterfaceAccess> {
  const canEdit = !interfaceOnly && roleAllows(resource.role, 'base:manage_interfaces');
  const found = (await listInterfaces(tx, resource.baseId, canEdit, resource.id))[0];
  const [base] = await tx
    .select({ name: bases.name })
    .from(bases)
    .where(eq(bases.id, resource.baseId));
  if (!found || !base) throw new AppError('NOT_FOUND', { detail: 'No such interface.' });
  return {
    interface: found,
    baseName: base.name,
    workspaceId: resource.workspaceId,
    canEdit,
    access: interfaceOnly ? 'interface' : 'base',
    role: resource.role,
  };
}

/** The interface's base (the resource's), checked against a page's path. */
export async function interfaceBase(tx: Transaction, interfaceId: string): Promise<string> {
  const [row] = await tx
    .select({ baseId: interfaces.baseId })
    .from(interfaces)
    .where(eq(interfaces.id, interfaceId));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such interface.' });
  return row.baseId;
}

async function pageTable(ctx: PageContext, config: InterfacePageConfig): Promise<TableRow> {
  const [table] = await ctx.tx
    .select()
    .from(tables)
    .where(
      and(eq(tables.id, config.tableId), eq(tables.baseId, ctx.baseId), isNull(tables.deletedAt))
    );
  if (!table) throw new AppError('NOT_FOUND', { detail: "This page's table was deleted." });
  return table;
}

interface PageShape {
  /** Fields whose values leave through the records route. */
  shown: string[];
  /** Self-link fields whose structure leaves as ids of shown records (a timeline's arrows). */
  links: string[];
  shape: SharedViewShape | null;
  /** The page lists records at all (dashboards and forms don't). */
  lists: boolean;
}

/**
 * What a page shows of its table: a record list's primary field and columns, a record review's
 * and its field elements, a view-like layout's (as the view would: `sharedViewShape`), a form's
 * fields; and every layout the fields of its filter elements (their choices).
 */
export function pageShape(
  config: InterfacePageConfig,
  fields: readonly { id: string; type: string; isPrimary: boolean; options?: unknown }[]
): PageShape {
  const live = new Set(fields.map((f) => f.id));
  const filters = config.elements.flatMap((el) => (el.type === 'filter' ? [el.fieldId] : []));
  const unique = (ids: string[]) => [...new Set(ids.filter((id) => live.has(id)))];
  if (VIEW_LIKE_LAYOUTS.includes(config.layout)) {
    const layout = config.layout as 'kanban' | 'calendar' | 'timeline';
    const shape = sharedViewShape(
      { type: layout, config: { [layout]: config[layout] ?? {} } },
      fields,
      config.tableId
    );
    return {
      shown: unique([...shape.fieldIds, ...filters]),
      links: shape.links,
      shape,
      lists: true,
    };
  }
  if (config.layout === 'form') {
    return {
      shown: unique((config.form?.fields ?? []).map((f) => f.fieldId)),
      links: [],
      shape: null,
      lists: false,
    };
  }
  const primary = fields.filter((f) => f.isPrimary).map((f) => f.id);
  const review =
    config.layout === 'recordReview'
      ? config.elements.flatMap((el) => (el.type === 'field' ? [el.fieldId] : []))
      : [];
  return {
    shown: unique([...primary, ...config.fields, ...review, ...filters]),
    links: [],
    shape: null,
    lists: config.layout !== 'dashboard',
  };
}

/** The fields the viewer may write through the page: editable field elements, or the form's. */
function writableFields(
  config: InterfacePageConfig,
  fields: readonly FieldInfo[],
  role: UserRole,
  hidden: ReadonlySet<string>
): Set<string> {
  const byId = new Map(fields.map((f) => [f.row.id, f]));
  const ok = (id: string) => {
    const f = byId.get(id);
    return !!f && !hidden.has(id) && isInterfaceWritableType(fieldType(f.row));
  };
  if (config.layout === 'recordReview' && roleAllows(role, 'record:update')) {
    return new Set(
      config.elements
        .flatMap((el) => (el.type === 'field' && el.editable ? [el.fieldId] : []))
        .filter(ok)
    );
  }
  if (config.layout === 'form' && roleAllows(role, 'record:create')) {
    return new Set((config.form?.fields ?? []).map((f) => f.fieldId).filter(ok));
  }
  return new Set<string>();
}

const toMeta = (f: FieldInfo) => ({
  id: f.row.id,
  name: f.row.name,
  type: fieldType(f.row),
  options: publicFieldOptions(fieldType(f.row), f.row.config),
  isPrimary: f.row.isPrimary,
});

interface CompiledPage {
  table: TableRow;
  fields: FieldInfo[];
  hidden: ReadonlySet<string>;
  shape: PageShape;
  shared: SharedViewQuery;
}

/**
 * The page compiled as its viewer reads it: the page filter and sorts (pruned of fields gone
 * since), the viewer's filter elements (`within`), `me` as the viewer, only the shown fields
 * less the ones hidden from them. A page whose filter no longer compiles shows nothing (404)
 * rather than unfiltered records.
 */
async function compilePage(
  ctx: PageContext,
  config: InterfacePageConfig,
  filterValues: Readonly<Record<string, unknown>>
): Promise<CompiledPage> {
  const table = await pageTable(ctx, config);
  const fields = await tableFields(ctx.tx, table);
  const hidden = ctx.visibility.hiddenFields({ userId: ctx.userId, role: ctx.role }, table.id);
  const metas = fields.map((f) => ({
    id: f.row.id,
    type: fieldType(f.row),
    isPrimary: f.row.isPrimary,
    options: f.options,
  }));
  const shape = pageShape(config, metas);
  const shown = new Set(shape.shown.filter((id) => !hidden.has(id)));
  const linkIds = new Set(shape.links.filter((id) => !hidden.has(id)));
  const visible = fields.filter((f) => shown.has(f.row.id));
  const links = fields.filter((f) => linkIds.has(f.row.id) && f.link);
  const queryFields = toQueryFields(fields);
  const stored = pruneViewQuery({ filter: config.filter, sorts: config.sorts }, queryFields);
  const within = filterElementConditions(config.elements, filterValues, metas).filter(
    (c) => !hidden.has(c.fieldId)
  );
  try {
    const query = viewQuerySchema.parse({
      ...stored,
      fields: [...new Set([...visible, ...links].map((f) => f.row.id))],
      ...(within.length > 0 ? { within } : {}),
    });
    const compiled = compileViewQuery(query, queryFields, { userId: ctx.userId });
    return {
      table,
      fields,
      hidden,
      shape,
      shared: {
        fields: visible,
        links,
        layout: gridLayoutOf({}),
        shape: shape.shape ?? { fieldIds: [...shown], links: [], dateFields: [] },
        query,
        queryFields,
        compiled,
        userId: ctx.userId,
      },
    };
  } catch (err) {
    throw new AppError('NOT_FOUND', {
      detail: "This page can't be shown: its filter no longer works.",
      cause: err,
    });
  }
}

/** A window of the page's records as its viewer may see them, with the fields' settings. */
export async function pageRecords(
  ctx: PageContext,
  config: InterfacePageConfig,
  q: {
    filters: Readonly<Record<string, unknown>>;
    offset: number;
    limit: number;
    from?: string | undefined;
    to?: string | undefined;
  }
): Promise<InterfacePageRecords> {
  const page = await compilePage(ctx, config, q.filters);
  const read = { tx: ctx.tx, workspaceId: ctx.workspaceId, table: page.table };
  const answer = page.shape.lists
    ? await sharedRecords(read, page.shared, q)
    : { records: [], offset: q.offset, total: 0 };
  const writable = writableFields(config, page.fields, ctx.role, page.hidden);
  return {
    table: { id: page.table.id, name: page.table.name },
    fields: page.fields
      .filter((f) => page.shared.fields.some((v) => v.row.id === f.row.id))
      .map(toMeta),
    ...answer,
    editable: config.layout === 'recordReview' ? [...writable] : [],
    canSubmit: config.layout === 'form' && roleAllows(ctx.role, 'record:create'),
    ...(page.shape.shape?.kanban ? { kanban: page.shape.shape.kanban } : {}),
    ...(page.shape.shape?.calendar ? { calendar: page.shape.shape.calendar } : {}),
    ...(page.shape.shape?.timeline ? { timeline: page.shape.shape.timeline } : {}),
  };
}

function refuseFields(ids: string[], what: string): void {
  if (ids.length === 0) return;
  throw new AppError('FORBIDDEN', {
    detail: what,
    extensions: {
      errors: ids.map((id) => ({ path: `fields.${id}`, message: 'Not on this page.' })),
    },
  });
}

/**
 * Edits a record through a record review page: only its editable field elements' fields, only a
 * record the page lists (its filter, `me` as the viewer), then the RecordService's own checks
 * (role, table and field permissions, values).
 */
export async function updatePageRecord(
  ctx: PageContext & { entitlements: Entitlements },
  config: InterfacePageConfig,
  recordId: string,
  cells: Record<string, unknown>
): Promise<void> {
  if (config.layout !== 'recordReview') {
    throw new AppError('FORBIDDEN', { detail: "This page doesn't edit records." });
  }
  const page = await compilePage(ctx, config, {});
  const writable = writableFields(config, page.fields, ctx.role, page.hidden);
  refuseFields(
    Object.keys(cells).filter((id) => !writable.has(id)),
    "This page doesn't let you edit these fields."
  );
  if (!(await recordMatches(ctx.tx, page.table, page.shared.compiled, recordId))) {
    throw new AppError('NOT_FOUND', { detail: 'No such record on this page.' });
  }
  await updateRecords(
    {
      tx: ctx.tx,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      table: page.table,
      role: ctx.role,
      entitlements: ctx.entitlements,
    },
    [{ id: recordId, fields: cells }]
  );
}

const blank = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Submits a form page: a new record of its fields only, required ones filled. */
export async function submitPageForm(
  ctx: PageContext & { entitlements: Entitlements },
  config: InterfacePageConfig,
  cells: Record<string, unknown>
): Promise<{ id: string }> {
  if (config.layout !== 'form') {
    throw new AppError('FORBIDDEN', { detail: 'This page is not a form.' });
  }
  const table = await pageTable(ctx, config);
  const fields = await tableFields(ctx.tx, table);
  const hidden = ctx.visibility.hiddenFields({ userId: ctx.userId, role: ctx.role }, table.id);
  const writable = writableFields(config, fields, ctx.role, hidden);
  if (!roleAllows(ctx.role, 'record:create')) {
    throw new AppError('FORBIDDEN', { detail: "You can't submit this form." });
  }
  refuseFields(
    Object.keys(cells).filter((id) => !writable.has(id)),
    "This form doesn't have these fields."
  );
  const missing = (config.form?.fields ?? []).filter(
    (f) => f.required && writable.has(f.fieldId) && blank(cells[f.fieldId])
  );
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Fill in the required fields.',
      extensions: {
        errors: missing.map((f) => ({ path: `fields.${f.fieldId}`, message: 'Required.' })),
      },
    });
  }
  const [created] = await createRecords(
    {
      tx: ctx.tx,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      table,
      role: ctx.role,
      entitlements: ctx.entitlements,
    },
    [cells]
  );
  if (!created) throw new Error('submit form page: no record created');
  return { id: created.id };
}
