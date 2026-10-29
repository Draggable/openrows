import { type PlanOverrides, planIdSchema, planOverridesSchema } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { inScope } from '../authz/scope.js';
import type { Database, Transaction } from '../db/index.js';

/**
 * A workspace's stored plan: `workspaces.plan` (null: the edition's default plan) and the
 * operators' `plan_overrides`. The core stores them; what a plan means is the edition's
 * EntitlementsProvider's business (the plan catalog in the hosted edition, nothing in OSS).
 */
export interface WorkspacePlan {
  plan: string | null;
  overrides: PlanOverrides;
}

/** The channel `workspace_plan_set` notifies with the workspace's id. */
export const PLAN_CHANNEL = 'workspace_plan';

/**
 * The workspace's stored plan, read in the caller's workspace-scoped transaction (RLS); null when
 * it can't see the workspace. Overrides that no longer parse (a limit or feature removed since)
 * are dropped, never fatal.
 */
export async function readWorkspacePlan(
  tx: Transaction,
  workspaceId: string
): Promise<WorkspacePlan | null> {
  const { rows } = await tx.execute<{ plan: string | null; plan_overrides: unknown }>(
    sql`SELECT plan, plan_overrides FROM workspaces WHERE id = ${workspaceId}::uuid`
  );
  const row = rows[0];
  if (!row) return null;
  const overrides = planOverridesSchema.safeParse(row.plan_overrides);
  return { plan: row.plan, overrides: overrides.success ? overrides.data : {} };
}

/** `readWorkspacePlan` in a transaction of its own, scoped to the workspace (operators' tools). */
export function loadWorkspacePlan(
  db: Database,
  workspaceId: string
): Promise<WorkspacePlan | null> {
  return inScope(db, { userId: '', workspaceId }, (tx) => readWorkspacePlan(tx, workspaceId));
}

/**
 * Sets the workspace's plan and overrides through `workspace_plan_set` (the app role can't
 * update the columns itself), which notifies every process to drop its cached entitlements.
 * For operators' tools (the hosted plan CLI) and billing; never a tenant route. False when there is
 * no such workspace.
 */
export async function setWorkspacePlan(
  db: Database,
  workspaceId: string,
  value: WorkspacePlan
): Promise<boolean> {
  const plan = value.plan === null ? null : planIdSchema.parse(value.plan);
  const overrides = planOverridesSchema.parse(value.overrides);
  const { rows } = await db.execute<{ ok: boolean }>(
    sql`SELECT workspace_plan_set(${workspaceId}::uuid, ${plan}::text, ${JSON.stringify(overrides)}::jsonb) AS ok`
  );
  return rows[0]?.ok === true;
}
