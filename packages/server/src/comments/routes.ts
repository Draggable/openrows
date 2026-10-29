import { commentReactionSchema, contracts } from '@openrows/shared';
import type { Context } from 'hono';
import type { ResourceEnv } from '../authz/middleware.js';
import type { RouteRegistry } from '../authz/routes.js';
import { loadTable } from '../tables/service.js';
import {
  type CommentContext,
  commentCounts,
  createComment,
  deleteComment,
  listComments,
  mentionableUsers,
  setReaction,
  updateComment,
} from './service.js';

/** The path's reaction, already checked against the catalog (else 404). */
const reaction = (params: { reaction: string }) => commentReactionSchema.parse(params.reaction);

async function contextOf(
  c: Context<ResourceEnv<'table'>>,
  body: { clientOpId?: string } = {}
): Promise<CommentContext> {
  const { tx, resource, principal } = c.var;
  return {
    tx,
    workspaceId: resource.workspaceId,
    userId: principal.user.id,
    role: resource.role,
    table: await loadTable(tx, resource.id),
    clientOpId: body.clientOpId,
  };
}

/**
 * Record comments, under the record: authorized on the table in the path. Reading needs
 * `comment:read` (read-only and up), every write `comment:create` (commenters and up); the
 * service adds the author rule for edits and `comment:moderate` for deleting others' comments.
 */
export function commentRoutes(routes: RouteRegistry) {
  const r = contracts.comments;
  const read = { resource: 'table', action: 'comment:read' } as const;
  const write = { resource: 'table', action: 'comment:create' } as const;

  routes.endpoint(r.list, read, async (c, { params, query }) =>
    listComments(await contextOf(c), params.recordId, query)
  );

  routes.endpoint(r.create, write, async (c, { params, body }) =>
    createComment(await contextOf(c, body), params.recordId, body)
  );

  routes.endpoint(r.update, write, async (c, { params, body }) =>
    updateComment(await contextOf(c, body), params.recordId, params.commentId, body)
  );

  routes.endpoint(r.delete, write, async (c, { params }) => {
    await deleteComment(await contextOf(c), params.recordId, params.commentId);
    return null;
  });

  routes.endpoint(r.react, write, async (c, { params }) =>
    setReaction(await contextOf(c), params.recordId, params.commentId, reaction(params), true)
  );

  routes.endpoint(r.unreact, write, async (c, { params }) =>
    setReaction(await contextOf(c), params.recordId, params.commentId, reaction(params), false)
  );

  routes.endpoint(r.counts, read, async (c) => ({
    counts: await commentCounts(await contextOf(c)),
  }));

  routes.endpoint(r.mentionable, write, async (c) => ({
    userIds: await mentionableUsers(await contextOf(c)),
  }));
}
