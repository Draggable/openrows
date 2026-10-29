import {
  apiTypeOf,
  type CreateFieldInput,
  type FieldTypeName,
  fieldTypeForApi,
  getFieldType,
  type UserRole,
  type V1_PERMISSION_LEVELS,
} from '@openrows/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Principal } from '../auth/sessions.js';
import { authorize } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { setScope } from '../authz/scope.js';
import {
  baseMembers,
  bases,
  type Database,
  type Transaction,
  views,
  workspaceMembers,
  workspaces,
} from '../db/index.js';
import { type FieldRow, fieldType, liveFields, type TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { liveTables } from '../tables/service.js';
import { visibleTo } from '../views/visibility.js';

/** The REST API v1's metadata: bases, tables, fields and views in Airtable's shape. */

const LEVELS: Record<UserRole, (typeof V1_PERMISSION_LEVELS)[number]> = {
  owner: 'owner',
  creator: 'create',
  editor: 'edit',
  commenter: 'comment',
  read_only: 'read',
};

/** Most bases `GET /api/v1/meta/bases` lists (it has no further pages). */
export const MAX_V1_BASES = 1000;

/**
 * Every live base the caller can read, each through `authorize` (so a token sees only its
 * grants): all bases of the workspaces they're a member of, then their base-only ones.
 */
export async function listV1Bases(db: Database, principal: Principal) {
  const userId = principal.user.id;
  return db.transaction(async (tx) => {
    await setScope(tx, { userId });
    const memberships = await tx
      .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)))
      .orderBy(asc(workspaces.createdAt));
    const own = await tx
      .select({ baseId: baseMembers.baseId })
      .from(baseMembers)
      .where(eq(baseMembers.userId, userId))
      .limit(MAX_V1_BASES);
    const out: { id: string; name: string; permissionLevel: (typeof LEVELS)[UserRole] }[] = [];
    for (const m of memberships) {
      await setScope(tx, { userId, workspaceId: m.workspaceId });
      const rows = await tx
        .select({ base: bases, baseRole: baseMembers.role })
        .from(bases)
        .leftJoin(
          baseMembers,
          and(eq(baseMembers.baseId, bases.id), eq(baseMembers.userId, userId))
        )
        .where(and(eq(bases.workspaceId, m.workspaceId), isNull(bases.deletedAt)))
        .orderBy(asc(bases.createdAt))
        .limit(MAX_V1_BASES);
      for (const { base, baseRole } of rows) {
        const decision = authorize(principal, 'base:read', {
          kind: 'base',
          id: base.id,
          workspaceId: base.workspaceId,
          baseId: base.id,
          workspaceRole: m.role,
          baseRole,
        });
        if (decision.allowed) {
          out.push({ id: base.id, name: base.name, permissionLevel: LEVELS[decision.role] });
        }
      }
    }
    const listed = new Set(out.map((b) => b.id));
    for (const { baseId } of own) {
      if (listed.has(baseId)) continue;
      const resolved = await resolveResource(tx, 'base', baseId, userId);
      const decision = authorize(principal, 'base:read', resolved);
      if (!decision.allowed || !resolved) continue;
      await setScope(tx, { userId, workspaceId: resolved.workspaceId });
      const [base] = await tx.select({ name: bases.name }).from(bases).where(eq(bases.id, baseId));
      if (base) out.push({ id: baseId, name: base.name, permissionLevel: LEVELS[decision.role] });
    }
    return { bases: out.slice(0, MAX_V1_BASES) };
  });
}

/** A field in Airtable's shape: its type by Airtable's name, and ours. */
export function toV1Field(row: FieldRow) {
  const type = fieldType(row);
  const parsed = getFieldType(type).optionsSchema.safeParse(row.config ?? {});
  const options = parsed.success ? parsed.data : {};
  return {
    id: row.id,
    name: row.name,
    type: apiTypeOf({ type, options }),
    openrowsType: type,
    ...(row.description ? { description: row.description } : {}),
    options,
  };
}

/** Tables of a base with their fields and the views the user can see. */
export async function v1Tables(tx: Transaction, baseId: string, userId: string, only?: TableRow) {
  const tables = only ? [only] : await liveTables(tx, baseId);
  if (tables.length === 0) return [];
  const viewRows = await tx
    .select({ id: views.id, name: views.name, type: views.type, tableId: views.tableId })
    .from(views)
    .where(
      and(
        inArray(
          views.tableId,
          tables.map((t) => t.id)
        ),
        isNull(views.deletedAt),
        visibleTo(userId)
      )
    )
    .orderBy(asc(views.position));
  const out = [];
  for (const table of tables) {
    const fields = await liveFields(tx, table.id);
    const primary = fields.find((f) => f.isPrimary) ?? fields[0];
    out.push({
      id: table.id,
      name: table.name,
      ...(table.description ? { description: table.description } : {}),
      primaryFieldId: primary?.id ?? '',
      fields: fields.map(toV1Field),
      views: viewRows
        .filter((v) => v.tableId === table.id)
        .map((v) => ({ id: v.id, name: v.name, type: v.type })),
    });
  }
  return out;
}

/** A REST API field to create, with our type for its type name (ours or Airtable's). */
export function fieldInput(
  input: {
    name: string;
    type: string;
    description?: string | undefined;
    options?: Record<string, unknown> | undefined;
  },
  path: string
): CreateFieldInput {
  const type: FieldTypeName | null = fieldTypeForApi(input.type);
  if (!type) {
    throw new AppError('VALIDATION_FAILED', {
      detail: `Unknown field type "${input.type}".`,
      extensions: { errors: [{ path, message: 'Unknown field type.' }] },
    });
  }
  return {
    name: input.name,
    type,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.options ? { options: withChoiceIds(type, input.options) } : {}),
  };
}

/**
 * Airtable's new choices are `{ name }` (maybe with a colour of its palette): ours get ids and
 * colours from the type's `withChoices`, as typecast's new options do.
 */
function withChoiceIds(type: FieldTypeName, options: Record<string, unknown>) {
  const def = getFieldType(type);
  const choices = options['choices'];
  const named =
    Array.isArray(choices) &&
    choices.every((c) => c && typeof c === 'object' && !('id' in c) && typeof c.name === 'string');
  if (!def.withChoices || !named) return options;
  const rest = def.optionsSchema.safeParse({ ...options, choices: [] });
  if (!rest.success) return options;
  const names = (choices as { name: string }[]).map((c) => c.name);
  return def.withChoices(rest.data, names) as Record<string, unknown>;
}
