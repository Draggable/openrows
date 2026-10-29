import { sql } from 'drizzle-orm';
import type { Principal } from '../auth/sessions.js';
import type { Database } from '../db/index.js';
import type { ResolvedResource } from './policy.js';
import { inScope } from './scope.js';

/** How stale a person's last activity in a workspace gets before a request touches it. */
export const ACTIVITY_TOUCH_MINUTES = 10;

/** Whether this request should record the principal's activity in the resource's workspace. */
export function activityDue(
  principal: Principal,
  resource: Pick<ResolvedResource, 'lastActiveAt'>,
  now: number = Date.now()
): boolean {
  // An admin viewing the app as someone isn't them being active.
  if (principal.impersonation) return false;
  const last = resource.lastActiveAt;
  return !last || now - last.getTime() >= ACTIVITY_TOUCH_MINUTES * 60_000;
}

/**
 * Records that `userId` used the workspace now (the admin console's member list), in a
 * short transaction of its own after the request's: it never waits behind a long request's row
 * lock (lock_timeout) and never fails the request.
 */
export async function touchActivity(
  db: Database,
  workspaceId: string,
  userId: string,
  log?: { warn: (o: object, m: string) => void }
): Promise<void> {
  try {
    await inScope(db, { userId, workspaceId }, async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
      await tx.execute(sql`
        INSERT INTO workspace_member_activity (workspace_id, user_id, last_active_at)
        VALUES (${workspaceId}::uuid, ${userId}::uuid, now())
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET last_active_at = now()`);
    });
  } catch (err) {
    log?.warn({ err }, 'authz: could not record the member activity');
  }
}
