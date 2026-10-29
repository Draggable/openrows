import { ACCOUNT_REAUTH_MINUTES, type AccountWorkspace, contracts } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { deleteCookie } from 'hono/cookie';
import { SESSION_COOKIE } from '../auth/session-token.js';
import type { RouteRegistry } from '../authz/routes.js';
import { inScope } from '../authz/scope.js';
import type { Config } from '../config.js';
import type { Database, Transaction } from '../db/index.js';
import type { Jobs } from '../jobs/send.js';
import { AppError } from '../lib/errors.js';

/** The Privacy Policy's promise: personal data and workspace content gone within 30 days. */
const PURGE_WITHIN_DAYS = 30;

/** The workspaces `userId` owns and what deleting the account does to each. */
async function ownedWorkspaces(tx: Transaction, userId: string): Promise<AccountWorkspace[]> {
  const { rows } = await tx.execute<{
    workspace_id: string;
    name: string;
    other_owners: number;
    others: number;
  }>(sql`SELECT * FROM account_owned_workspaces(${userId}::uuid)`);
  return rows.map((r) => ({
    id: r.workspace_id,
    name: r.name,
    others: r.others,
    outcome: r.other_owners > 0 ? 'leave' : r.others > 0 ? 'blocked' : 'delete',
  }));
}

/** Until when the session's sign-in counts as recent, or null. */
function recentUntil(authenticatedAt: Date | null | undefined, now: Date): Date | null {
  if (!authenticatedAt) return null;
  const until = new Date(authenticatedAt.getTime() + ACCOUNT_REAUTH_MINUTES * 60_000);
  return until > now ? until : null;
}

/**
 * Deleting your own account. Session only (never a token), and only ever the caller's
 * account: there is no user id in the path. `POST /api/me/delete` needs a recent sign-in
 * (`/auth/login?reauth=1`) and the account's email typed again; it refuses while the user is the
 * only owner of a workspace others are in. It marks the account deleted, ends every session,
 * deletes the user's tokens and the workspaces only they are in, and sends the `purge.deleted`
 * job, which hard-deletes all of it (and the provider's user) within minutes; the hourly run
 * catches anything a failure left.
 */
export function accountRoutes(
  routes: RouteRegistry,
  { db, config, jobs }: { db: Database; config: Config; jobs: Jobs }
) {
  const me = contracts.me;
  const secure = config.appUrl.startsWith('https:');

  routes.endpoint(me.deletion, 'session', async (c) => {
    const { user, session } = c.var.principal;
    const until = recentUntil(session.authenticatedAt, new Date());
    return {
      email: user.email,
      workspaces: await inScope(db, { userId: user.id }, (tx) => ownedWorkspaces(tx, user.id)),
      reauthenticatedUntil: until?.toISOString() ?? null,
    };
  });

  routes.endpoint(me.delete, 'session', async (c, { body }) => {
    const { user, session } = c.var.principal;
    const now = new Date();
    if (!recentUntil(session.authenticatedAt, now)) {
      throw new AppError('REAUTHENTICATION_REQUIRED', {
        detail: `Sign in again (within the last ${ACCOUNT_REAUTH_MINUTES} minutes) to delete your account.`,
      });
    }
    if (!user.email || body.confirmEmail.toLowerCase() !== user.email.toLowerCase()) {
      throw new AppError('VALIDATION_FAILED', {
        detail: "Type your account's email address to confirm.",
        extensions: {
          errors: [{ path: 'confirmEmail', message: 'Does not match your email address.' }],
        },
      });
    }
    const deleted = await inScope(db, { userId: user.id }, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${user.id} FOR UPDATE`);
      const blocked = (await ownedWorkspaces(tx, user.id)).filter((w) => w.outcome === 'blocked');
      if (blocked.length > 0) {
        throw new AppError('SOLE_OWNER', {
          detail: `You're the only owner of ${blocked.map((w) => `"${w.name}"`).join(', ')}. Make someone else an owner or delete ${blocked.length === 1 ? 'it' : 'them'} first.`,
        });
      }
      const { rows } = await tx.execute<{ id: string }>(
        sql`SELECT account_request_deletion AS id FROM account_request_deletion(${user.id}::uuid)`
      );
      await jobs.send(tx, 'purge.deleted', null);
      return rows.length;
    });
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure, httpOnly: true });
    c.var.logger.info({ userId: user.id, workspaces: deleted }, 'account deleted');
    return {
      purgeBy: new Date(now.getTime() + PURGE_WITHIN_DAYS * 24 * 3600 * 1000).toISOString(),
      workspaces: deleted,
    };
  });
}
