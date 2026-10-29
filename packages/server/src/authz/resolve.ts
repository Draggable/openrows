import {
  BASE_ROLES,
  type BaseRole,
  INTERFACE_ROLES,
  type InterfaceRole,
  type ResourceKind,
  USER_ROLES,
  type UserRole,
} from '@openrows/shared';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';
import type { ResolvedResource } from './policy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row extends Record<string, unknown> {
  workspace_id: string;
  base_id: string | null;
  workspace_role: string | null;
  base_role: string | null;
  suspended: boolean;
  interface_role: string | null;
  tokens_allowed: boolean;
  last_active_at: string | Date | null;
}

function asRole<R extends string>(roles: readonly R[], value: string | null): R | null {
  return value !== null && (roles as readonly string[]).includes(value) ? (value as R) : null;
}

/**
 * Loads a resource's workspace, base and the user's roles there in one query, through the
 * SECURITY DEFINER function `authz_resolve` (drizzle/0003_rls.sql), because RLS hides every
 * tenant row until the workspace is known. Null when the resource doesn't exist, is in the
 * trash, or the id isn't a UUID.
 */
export async function resolveResource<K extends ResourceKind>(
  db: Database | Transaction,
  kind: K,
  id: string | undefined,
  userId: string
): Promise<ResolvedResource<K> | null> {
  if (!id || !UUID.test(id)) return null;
  const { rows } = await db.execute<Row>(
    sql`SELECT * FROM authz_resolve(${kind}, ${id}::uuid, ${userId}::uuid)`
  );
  const row = rows[0];
  if (!row) return null;
  return {
    kind,
    id,
    workspaceId: row.workspace_id,
    baseId: row.base_id,
    workspaceRole: asRole<UserRole>(USER_ROLES, row.workspace_role),
    baseRole: asRole<BaseRole>(BASE_ROLES, row.base_role),
    suspended: row.suspended === true,
    tokensAllowed: row.tokens_allowed !== false,
    lastActiveAt: row.last_active_at === null ? null : new Date(row.last_active_at),
    ...(kind === 'interface'
      ? { interfaceRole: asRole<InterfaceRole>(INTERFACE_ROLES, row.interface_role) }
      : {}),
  };
}
