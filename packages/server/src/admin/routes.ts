import { contracts } from '@openrows/shared';
import { and, desc, eq } from 'drizzle-orm';
import { auditForUser, requestActor } from '../audit/record.js';
import type { RouteRegistry } from '../authz/routes.js';
import { inScope } from '../authz/scope.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { adminAuditLog } from '../db/schema.js';
import { appendAdminAudit, requestIp } from './audit.js';
import { endImpersonation } from './impersonation.js';

/** Entries in a user's support access list. */
const SUPPORT_ACCESS_LIMIT = 50;

/**
 * The account side of the ops console, in the core because every user has it:
 * - `GET /api/me/support-access`: when staff impersonated the account (its account activity),
 *   read under RLS (`target_read`: entries naming the caller). Session only.
 * - `DELETE /api/me/impersonation`: the impersonating admin's way back (the one change
 *   requireSession lets an impersonation make), audited.
 */
export function adminAccountRoutes(
  routes: RouteRegistry,
  { db, config }: { db: Database; config: Config }
) {
  routes.endpoint(contracts.me.supportAccess, 'session', async (c) => {
    const { user } = c.var.principal;
    const rows = await inScope(db, { userId: user.id }, (tx) =>
      tx
        .select({ detail: adminAuditLog.detail, createdAt: adminAuditLog.createdAt })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.targetUserId, user.id),
            eq(adminAuditLog.action, 'impersonation.start')
          )
        )
        .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
        .limit(SUPPORT_ACCESS_LIMIT)
    );
    return {
      entries: rows.map((r) => {
        const detail = (r.detail ?? {}) as { reason?: unknown; expiresAt?: unknown };
        const expiresAt = typeof detail.expiresAt === 'string' ? new Date(detail.expiresAt) : null;
        return {
          startedAt: r.createdAt.toISOString(),
          expiresAt: (expiresAt && !Number.isNaN(expiresAt.getTime())
            ? expiresAt
            : r.createdAt
          ).toISOString(),
          reason: typeof detail.reason === 'string' ? detail.reason : null,
        };
      }),
    };
  });

  routes.endpoint(contracts.me.endImpersonation, 'session', async (c) => {
    const { impersonation, session, user, token } = c.var.principal;
    if (token || !impersonation) return null;
    await endImpersonation(db, session.idHash);
    await inScope(db, { userId: impersonation.adminId }, (tx) =>
      appendAdminAudit(tx, {
        adminId: impersonation.adminId,
        action: 'impersonation.end',
        targetUserId: user.id,
        ip: requestIp(c, config),
      })
    );
    // The impersonated user's workspaces' audit logs, as the admin.
    await auditForUser(db, c.var.edition.audit, user.id, {
      action: 'impersonation.end',
      actor: requestActor(c),
      target: { type: 'user', id: user.id, name: user.email ?? null },
    }).catch((err) => c.var.logger.error({ err }, 'could not audit the impersonation'));
    return null;
  });
}
