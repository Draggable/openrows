import { contracts } from '@openrows/shared';
import { auditForUser, requestActor } from '../audit/record.js';
import type { RouteRegistry } from '../authz/routes.js';
import { inScope } from '../authz/scope.js';
import type { Database } from '../db/index.js';
import { createToken, listTokens, revokeToken } from './service.js';

/**
 * Personal access tokens: the signed-in user lists, creates and revokes their own, in
 * their user-only scope. Session only: a token can't mint or revoke tokens.
 */
export function tokenRoutes(routes: RouteRegistry, { db }: { db: Database }) {
  const t = contracts.tokens;

  routes.endpoint(t.list, 'session', async (c) => {
    const userId = c.var.principal.user.id;
    return { tokens: await inScope(db, { userId }, (tx) => listTokens(tx, userId)) };
  });

  routes.endpoint(t.create, 'session', async (c, { body }) => {
    const userId = c.var.principal.user.id;
    const created = await inScope(db, { userId }, (tx) => createToken(tx, userId, body));
    c.var.logger.info({ tokenId: created.id }, 'personal access token created');
    // The audit log of each of the user's workspaces: name, prefix and scopes, never the token.
    await auditForUser(db, c.var.edition.audit, userId, {
      action: 'token.create',
      actor: requestActor(c),
      target: { type: 'token', id: created.id, name: created.name },
      summary: {
        after: {
          prefix: created.prefix,
          scopes: created.scopes,
          workspaces: created.workspaceIds.length,
          bases: created.baseIds.length,
          expiresAt: created.expiresAt,
        },
      },
    }).catch((err) => c.var.logger.error({ err }, 'could not audit the token'));
    return created;
  });

  routes.endpoint(t.revoke, 'session', async (c, { params }) => {
    const userId = c.var.principal.user.id;
    await inScope(db, { userId }, (tx) => revokeToken(tx, userId, params.tokenId));
    c.var.logger.info({ tokenId: params.tokenId }, 'personal access token revoked');
    await auditForUser(db, c.var.edition.audit, userId, {
      action: 'token.revoke',
      actor: requestActor(c),
      target: { type: 'token', id: params.tokenId },
    }).catch((err) => c.var.logger.error({ err }, 'could not audit the token'));
    return null;
  });
}
