import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';

export interface Scope {
  userId: string;
  /** Omitted for user-level queries ("my workspaces"), before a workspace is chosen. */
  workspaceId?: string;
  /**
   * An interface-only collaborator's interface: interfaces, pages and interface members
   * then show this interface's rows only (the `interface_scope` policies).
   */
  interfaceId?: string;
}

/**
 * Sets the RLS context for the rest of the transaction (ADR-002): `set_config(..., true)` is
 * SET LOCAL, so it ends with the transaction and can't leak to the next user of a pooled
 * connection. Callable again inside the same transaction to narrow it to a workspace.
 */
export async function setScope(tx: Transaction, scope: Scope): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('app.user_id', ${scope.userId}, true),
               set_config('app.workspace_id', ${scope.workspaceId ?? ''}, true),
               set_config('app.interface_id', ${scope.interfaceId ?? ''}, true)`
  );
}

/**
 * Runs `fn` in a transaction scoped to `scope`. Tenant tables only show rows of
 * `scope.workspaceId` (and, for memberships, the user's own); without one they show nothing but
 * the user's memberships and workspaces. Use only after `authorize` allowed the request.
 */
export function inScope<T>(db: Database, scope: Scope, fn: (tx: Transaction) => Promise<T>) {
  return db.transaction(async (tx) => {
    await setScope(tx, scope);
    return fn(tx);
  });
}
