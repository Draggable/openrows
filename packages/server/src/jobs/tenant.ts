import { z } from 'zod';
import { inScope } from '../authz/scope.js';
import type { Database, Transaction } from '../db/index.js';

/**
 * Runs `fn` in a transaction scoped to one workspace (ADR-002): a job sees and writes only its
 * tenant's rows, through RLS, exactly like a request. The worker connects as openrows_app, so a
 * job that forgets the scope sees no tenant rows at all.
 */
export function withTenant<T>(
  db: Database,
  workspaceId: string,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  return inScope(db, { userId: '', workspaceId }, fn);
}

/** Every tenant job's data carries its workspace (ADR-004's job rules). */
export const tenantJobData = z.object({ workspaceId: z.uuid() });

/**
 * A job handler that runs in its tenant's scope: the job's data is checked against `schema`
 * (a job with bad data fails, and after its retries lands in the dead-letter queue), then `fn`
 * runs inside `withTenant` for the data's `workspaceId`.
 */
export function tenantJob<S extends z.ZodType<{ workspaceId: string }>>(
  db: Database,
  schema: S,
  fn: (tx: Transaction, data: z.infer<S>) => Promise<unknown>
): (data: unknown) => Promise<unknown> {
  return async (raw) => {
    const data = schema.parse(raw);
    return withTenant(db, data.workspaceId, (tx) => fn(tx, data));
  };
}
