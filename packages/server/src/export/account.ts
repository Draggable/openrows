import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { ObjectStore } from '../attachments/storage.js';
import { inScope } from '../authz/scope.js';
import {
  baseMembers,
  bases,
  type Database,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { type BaseExportOptions, entryName, planBaseExport } from './base.js';
import type { ZipEntry } from './zip.js';

/**
 * The account data export (the Privacy Policy's access and portability rights): a ZIP with
 *
 * - `account.json`: the profile (with the sign-in identity), notification setting, sessions
 *   (when, from which browser and IP; never their tokens), workspace memberships and base roles,
 *   and an index of the bases below;
 * - `comments.jsonl`: every comment the user wrote, in any workspace (`account_comments`);
 * - `bases/<n> <workspace>/<n> <base>/`: a whole-base export (base.ts) of every live base of
 *   the workspaces the user owns.
 */

export const ACCOUNT_EXPORT_FORMAT = 'openrows.account-export';
const COMMENT_PAGE = 1000;

interface CommentRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  base_id: string;
  table_id: string;
  record_id: string;
  body: string;
  created_at: string | Date;
  edited_at: string | Date | null;
}

const iso = (d: string | Date | null) =>
  d === null ? null : (typeof d === 'string' ? new Date(d) : d).toISOString();

export async function planAccountExport(
  db: Database,
  userId: string,
  store: ObjectStore | undefined,
  opts: Pick<BaseExportOptions, 'attachments' | 'onMissingFile'>
): Promise<{ entries: () => AsyncGenerator<ZipEntry> }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new AppError('NOT_FOUND', { detail: 'No such user.' });
  const sessionRows = await db
    .select({
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(asc(sessions.createdAt));
  // No workspace in scope: RLS shows this user's memberships and base roles only.
  const { memberships, baseRoles } = await inScope(db, { userId }, async (tx) => ({
    memberships: await tx
      .select({
        workspaceId: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
        joinedAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt)))
      .orderBy(asc(workspaces.createdAt)),
    baseRoles: await tx
      .select({
        workspaceId: baseMembers.workspaceId,
        baseId: baseMembers.baseId,
        role: baseMembers.role,
        since: baseMembers.createdAt,
      })
      .from(baseMembers)
      .where(eq(baseMembers.userId, userId))
      .orderBy(asc(baseMembers.createdAt)),
  }));

  const owned = memberships.filter((m) => m.role === 'owner');
  const ownedBases: { workspaceId: string; baseId: string; name: string; path: string }[] = [];
  for (const [w, ws] of owned.entries()) {
    const rows = await inScope(db, { userId, workspaceId: ws.workspaceId }, (tx) =>
      tx
        .select({ id: bases.id, name: bases.name })
        .from(bases)
        .where(and(eq(bases.workspaceId, ws.workspaceId), isNull(bases.deletedAt)))
        .orderBy(asc(bases.createdAt))
    );
    const folder = `bases/${String(w + 1).padStart(2, '0')} ${entryName(ws.name, 'Workspace')}`;
    for (const [b, base] of rows.entries()) {
      ownedBases.push({
        workspaceId: ws.workspaceId,
        baseId: base.id,
        name: base.name,
        path: `${folder}/${String(b + 1).padStart(2, '0')} ${entryName(base.name, 'Base')}/`,
      });
    }
  }

  const account = {
    format: ACCOUNT_EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      avatarUrl: user.avatarUrl,
      signIn: { issuer: user.oidcIssuer, subject: user.oidcSubject },
      isSystemAdmin: user.isSystemAdmin,
      notificationEmail: user.notificationEmail,
      personalWorkspaceId: user.personalWorkspaceId,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    sessions: sessionRows.map((s) => ({
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      userAgent: s.userAgent,
      ip: s.ip,
    })),
    workspaces: memberships.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
    baseRoles: baseRoles.map((r) => ({ ...r, since: r.since.toISOString() })),
    comments: 'comments.jsonl',
    bases: ownedBases,
  };

  async function* comments(): AsyncGenerator<string> {
    let after: string | null = null;
    for (;;) {
      const result = await db.execute<CommentRow>(
        sql`SELECT * FROM account_comments(${userId}::uuid, ${after}::uuid, ${COMMENT_PAGE})`
      );
      const rows: CommentRow[] = result.rows;
      let text = '';
      for (const c of rows) {
        text += `${JSON.stringify({
          id: c.id,
          workspaceId: c.workspace_id,
          baseId: c.base_id,
          tableId: c.table_id,
          recordId: c.record_id,
          body: c.body,
          createdAt: iso(c.created_at),
          editedAt: iso(c.edited_at),
        })}\n`;
      }
      yield text;
      const last: CommentRow | undefined = rows.at(-1);
      if (!last || rows.length < COMMENT_PAGE) return;
      after = last.id;
    }
  }

  async function* entries(): AsyncGenerator<ZipEntry> {
    yield { name: 'account.json', data: [`${JSON.stringify(account, null, 2)}\n`] };
    yield { name: 'comments.jsonl', data: comments() };
    for (const b of ownedBases) {
      const scope = { userId, workspaceId: b.workspaceId };
      // Planned when its turn comes: one base's schema in memory at a time. A base trashed since
      // the index was read is skipped.
      const plan = await inScope(db, scope, (tx) =>
        planBaseExport(db, tx, scope, b.baseId, store, {
          ...opts,
          directory: { workspaceId: b.workspaceId, bases: 'all', emails: true },
        })
      ).catch((err: unknown) => {
        if (err instanceof AppError && err.code === 'NOT_FOUND') return null;
        throw err;
      });
      if (plan) yield* plan.entries(b.path);
    }
  }

  return { entries };
}
