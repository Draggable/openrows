import { contracts } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import type { Database } from '../db/index.js';
import { dismissNotice, listNotices } from './service.js';

/**
 * Service notices: the signed-in user's banner list and its dismissal, per user. Session
 * only (a banner is for people, not tokens); notices themselves are published by the `notices`
 * command, never over HTTP.
 */
export function noticeRoutes(routes: RouteRegistry, { db }: { db: Database }) {
  routes.endpoint(contracts.notices.list, 'session', async (c) => ({
    notices: await listNotices(db, c.var.principal.user.id),
  }));
  routes.endpoint(contracts.notices.dismiss, 'session', async (c, { params }) => {
    await dismissNotice(db, c.var.principal.user.id, params.noticeId);
    return null;
  });
}
