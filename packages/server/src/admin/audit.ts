import type { AdminAuditAction } from '@openrows/shared';
import type { Context } from 'hono';
import { uuidv7 } from 'uuidv7';
import { clientIp } from '../auth/client-ip.js';
import type { Config } from '../config.js';
import type { Transaction } from '../db/index.js';
import { adminAuditLog } from '../db/schema.js';

/** One entry of the ops console's append-only audit log. */
export interface AdminAuditInput {
  adminId: string;
  action: AdminAuditAction;
  targetUserId?: string | null;
  targetWorkspaceId?: string | null;
  /** What else the entry needs (a query, a reason, the new plan). Never secrets. */
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * Appends an entry to `admin_audit_log`. `tx` must be scoped to the admin (`app.user_id`): RLS
 * lets only a live system admin insert, and only under their own id. Nothing can change or
 * delete an entry afterwards (0080_admin_console_rls.sql).
 */
export async function appendAdminAudit(tx: Transaction, entry: AdminAuditInput): Promise<string> {
  const id = uuidv7();
  await tx.insert(adminAuditLog).values({
    id,
    adminId: entry.adminId,
    action: entry.action,
    targetUserId: entry.targetUserId ?? null,
    targetWorkspaceId: entry.targetWorkspaceId ?? null,
    detail: entry.detail ?? {},
    ip: entry.ip ?? null,
  });
  return id;
}

/** The request's client IP, as the rest of the app reads it (TRUST_PROXY), for audit entries. */
export function requestIp(c: Context, config: Config): string | null {
  return clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops }) ?? null;
}
