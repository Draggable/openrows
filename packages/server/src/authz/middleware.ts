import type { ActionOn, ResourceKind, TokenScope } from '@openrows/shared';
import { TransactionRollbackError } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { SessionEnv } from '../auth/middleware.js';
import type { Database, Transaction } from '../db/index.js';
import { activityDue, touchActivity } from './activity.js';
import { type AuthorizedResource, assertAllowed, authorize, interfaceOnly } from './policy.js';
import { resolveResource } from './resolve.js';
import { setScope } from './scope.js';

/** Context of resource routes: the authorized resource and its workspace-scoped transaction. */
export interface ResourceEnv<K extends ResourceKind = ResourceKind> {
  Variables: SessionEnv['Variables'] & {
    resource: AuthorizedResource<K>;
    /** The request's transaction, with RLS scoped to the resource's workspace. */
    tx: Transaction;
  };
}

/**
 * Authorizes `action` on the `kind` named by path parameter `param` (default `<kind>Id`), then
 * runs the rest of the request in one transaction scoped to its workspace (ADR-002 §3). Needs
 * `requireSession` before it. Refusals: 404 when the resource doesn't exist or the user has no
 * role on it, 403 when the role is too low. The transaction rolls back if the handler throws.
 * `scope` replaces the action's token scope (`ACTION_SCOPES`) for this route.
 */
export function withResource<K extends ResourceKind>(
  db: Database,
  kind: K,
  action: ActionOn<K>,
  opts: { param?: string; scope?: TokenScope | null } = {}
): MiddlewareHandler<ResourceEnv<K>> {
  const param = opts.param ?? `${kind}Id`;
  return createMiddleware<ResourceEnv<K>>(async (c, next) => {
    const { principal } = c.var;
    const userId = principal.user.id;
    let touch: string | null = null;
    try {
      await db.transaction(async (tx) => {
        await setScope(tx, { userId });
        const resolved = await resolveResource(tx, kind, c.req.param(param), userId);
        const role = assertAllowed(authorize(principal, action, resolved, opts.scope));
        // assertAllowed only returns when resolved is non-null.
        const resource = { ...(resolved as NonNullable<typeof resolved>), role };
        await setScope(tx, {
          userId,
          workspaceId: resource.workspaceId,
          ...(interfaceOnly(resource) ? { interfaceId: resource.id } : {}),
        });
        if (activityDue(principal, resource)) touch = resource.workspaceId;
        c.set('resource', resource);
        c.set('tx', tx);
        await next();
        // Hono hands handler errors to onError without rethrowing them here.
        if (c.error) tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
    // The admin console's last activity, after the request's transaction.
    if (touch) await touchActivity(db, touch, userId, c.var.logger);
  });
}
