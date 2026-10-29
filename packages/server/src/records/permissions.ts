import {
  type EditPermission,
  fieldPermissionsOf,
  formsMayFill,
  type PermissionSubject,
  type ProblemFieldError,
  permissionAllows,
  tablePermissionsOf,
} from '@openrows/shared';
import { sql } from 'drizzle-orm';
import type { Transaction } from '../db/index.js';
import type { FieldRow, TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import type { LinkSpec } from './links.js';

/**
 * Table and field edit permissions, enforced here for every record write: the
 * RecordService calls these before it validates or writes anything, so REST, bulk writes,
 * paste and fill, CSV import, typecast's linked records, link conversions, kanban, calendar and
 * timeline drags (all record updates) and the future WebSocket ops are covered by one check.
 * The route has already checked the base role (`record:*`, editor and up).
 */

type RecordAction = 'addRecords' | 'deleteRecords' | 'editRecords';

const VERB: Record<RecordAction, string> = {
  addRecords: 'add records to',
  deleteRecords: 'delete records from',
  editRecords: 'edit records in',
};

/** 403 unless `who` may add, delete or edit the records of `table`. */
export function assertTableAllows(table: TableRow, action: RecordAction, who: PermissionSubject) {
  if (permissionAllows(tablePermissionsOf(table.permissions)[action], who)) return;
  throw new AppError('EDIT_RESTRICTED', {
    detail: `You don't have permission to ${VERB[action]} "${table.name}".`,
    extensions: { tableId: table.id, action },
  });
}

/** Whether `who` may edit cells of `field`: its table's `editRecords` and its own `edit`. */
export function canEditCells(table: TableRow, field: FieldRow, who: PermissionSubject) {
  return (
    permissionAllows(tablePermissionsOf(table.permissions).editRecords, who) &&
    permissionAllows(fieldPermissionsOf(field.permissions).edit, who)
  );
}

export interface WrittenField {
  row: FieldRow;
  link?: LinkSpec;
}

/** How a record write sets cells: an update, a create, or a public form's create. */
export type CellWriteMode = 'create' | 'update' | 'form';

/**
 * Why `who` can't write cells of `field` (`null` when they can). On an update, the table's
 * `editRecords` applies; on a create, only the field's own `edit` (adding records is
 * `addRecords`, checked separately); on a public form's create, the field's `edit` or its
 * "allow forms". A link cell also changes the linked records' inverse cells, so it needs
 * the inverse field's permission in the other table as well (for a form: or its "allow forms").
 */
export function cellDenial(
  table: TableRow,
  field: WrittenField,
  who: PermissionSubject,
  mode: CellWriteMode
): string | null {
  const own =
    mode === 'update'
      ? canEditCells(table, field.row, who)
      : mode === 'form'
        ? formsMayFill(fieldPermissionsOf(field.row.permissions))
        : permissionAllows(fieldPermissionsOf(field.row.permissions).edit, who);
  if (!own) return `You don't have permission to edit "${field.row.name}".`;
  const spec = field.link;
  if (
    spec?.inverse &&
    !canEditCells(spec.target, spec.inverse, who) &&
    !(mode === 'form' && fieldPermissionsOf(spec.inverse.permissions).allowForms === true)
  ) {
    return `You don't have permission to edit "${spec.inverse.name}" in "${spec.target.name}", which this link changes.`;
  }
  return null;
}

/**
 * 403 EDIT_RESTRICTED naming the fields (`fieldIds`) and each cell path of `errors`. The
 * detail is the one reason when there is one (a link's inverse field), else the field names.
 */
export function editRestricted(
  errors: ProblemFieldError[],
  fields: readonly { id: string; name: string }[]
): never {
  const reasons = [...new Set(errors.map((e) => e.message))];
  const names = fields.map((f) => `"${f.name}"`).join(', ');
  throw new AppError('EDIT_RESTRICTED', {
    detail: reasons.length === 1 ? reasons[0] : `You don't have permission to edit ${names}.`,
    extensions: { errors, fieldIds: fields.map((f) => f.id) },
  });
}

/**
 * Synced tables: their records come from the sync's source, so only the sync adds,
 * deletes or restores them (403 EDIT_RESTRICTED for anyone else).
 */
export function assertNotSyncedTable(table: TableRow, verb: string) {
  if (!table.synced) return;
  throw new AppError('EDIT_RESTRICTED', {
    detail: `"${table.name}" is synced from another table: you can't ${verb} its records here.`,
    extensions: { tableId: table.id, synced: true },
  });
}

/** 403 naming every synced field written in `inputs`: only the sync writes them. */
export function assertNoSyncedCells(
  fields: readonly WrittenField[],
  inputs: readonly { path: string; cells: Record<string, unknown> }[]
) {
  const synced = new Map(fields.filter((f) => f.row.synced).map((f) => [f.row.id, f.row]));
  if (!synced.size) return;
  const errors: ProblemFieldError[] = [];
  const denied = new Map<string, FieldRow>();
  for (const { path, cells } of inputs) {
    for (const fieldId of Object.keys(cells)) {
      const row = synced.get(fieldId);
      if (!row) continue;
      errors.push({
        path: `${path}.${fieldId}`,
        message: `"${row.name}" is synced from another table and can't be edited here.`,
      });
      denied.set(fieldId, row);
    }
  }
  if (errors.length) editRestricted(errors, [...denied.values()]);
}

/**
 * 403 naming every field (and cell path) of `inputs` that `who` can't write (`cellDenial`).
 * Unknown field ids are left to the validation that follows (422).
 */
export function assertCellsAllowed(
  table: TableRow,
  fields: readonly WrittenField[],
  inputs: readonly { path: string; cells: Record<string, unknown> }[],
  who: PermissionSubject,
  mode: CellWriteMode
) {
  const byId = new Map(fields.map((f) => [f.row.id, f]));
  const verdicts = new Map<string, string | null>();
  const errors: ProblemFieldError[] = [];
  const denied = new Map<string, FieldRow>();
  for (const { path, cells } of inputs) {
    for (const fieldId of Object.keys(cells)) {
      const field = byId.get(fieldId);
      if (!field) continue;
      let reason = verdicts.get(fieldId);
      if (reason === undefined) {
        reason = cellDenial(table, field, who, mode);
        verdicts.set(fieldId, reason);
      }
      if (!reason) continue;
      errors.push({ path: `${path}.${fieldId}`, message: reason });
      denied.set(fieldId, field.row);
    }
  }
  if (errors.length) editRestricted(errors, [...denied.values()]);
}

/**
 * The people a `specific` permission names must be collaborators of the table's base (workspace
 * members or the base's own), as for user cells: anyone else is a 422, so ids never probe who
 * exists in other workspaces. Answers the permissions as given.
 */
export async function assertPermissionUsers(
  tx: Transaction,
  table: { workspaceId: string; baseId: string },
  permissions: Record<string, EditPermission | undefined>,
  path: string
): Promise<void> {
  const named = Object.entries(permissions).flatMap(([key, p]) =>
    p?.level === 'specific' ? [{ key, ids: p.userIds }] : []
  );
  const all = [...new Set(named.flatMap((n) => n.ids))];
  if (!all.length) return;
  const list = `{${all.join(',')}}`;
  const { rows } = await tx.execute<{ user_id: string }>(sql`
    SELECT wm.user_id::text AS user_id FROM workspace_members wm
     WHERE wm.workspace_id = ${table.workspaceId} AND wm.user_id = ANY(${list}::uuid[])
    UNION
    SELECT bm.user_id::text FROM base_members bm
     WHERE bm.base_id = ${table.baseId} AND bm.user_id = ANY(${list}::uuid[])`);
  const known = new Set(rows.map((r) => r.user_id));
  const errors: ProblemFieldError[] = named.flatMap(({ key, ids }) =>
    ids.flatMap((id, i) =>
      known.has(id)
        ? []
        : [{ path: `${path}.${key}.userIds.${i}`, message: 'Not a collaborator of this base.' }]
    )
  );
  if (errors.length) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Only collaborators of this base can be given permissions.',
      extensions: { errors },
    });
  }
}
