import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type CreateShareInput,
  MAX_SHARE_LIFETIME_DAYS,
  MAX_SHARES_PER_VIEW,
  SHARE_TOKEN_RE,
  SHAREABLE_VIEW_TYPES,
  type Share,
  type SharedShare,
  type ShareKind,
  shareFrameAncestors,
  type UpdateShareInput,
  type ViewType,
} from '@openrows/shared';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/index.js';
import { bases, shares, tables, views } from '../db/index.js';
import type { TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { assertShareAllowed } from '../policies/repo.js';
import {
  compileSharedView,
  type SharedReadContext,
  type SharedViewQuery,
} from '../records/service.js';
import { loadTable } from '../tables/service.js';
import {
  checkShareAccess,
  checkShareDomain,
  hashSharePassword,
  passwordPromptExtensions,
  type ShareCredentials,
  type ShareLock,
  shareAccessExpiry,
  verifySharePassword,
} from './access.js';

/**
 * Share links. The token is the only credential of the public routes, so it is 32
 * random bytes, shown once, and stored as its SHA-256 only (legacy findings C8, H9, H10). It is
 * never logged (src/lib/context.ts redacts it from paths). Every public request resolves it again
 * (`share_resolve`), so revocation and expiry apply at once, and checks the link's email domains
 * and password (access.ts) before anything else is read.
 */

type ShareRow = typeof shares.$inferSelect;

export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What `shares.token_hash` stores: the token's SHA-256, hex. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const NO_SUCH_SHARE = () => new AppError('NOT_FOUND', { detail: 'No such share link.' });

function toShare(row: ShareRow, now: Date): Share {
  return {
    id: row.id,
    kind: row.kind,
    viewId: row.viewId,
    baseId: row.baseId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime(),
    hasPassword: row.passwordHash !== null,
    allowedDomains: row.allowedDomains,
    allowCopy: row.allowCopy,
    allowDownload: row.allowDownload,
    embedOrigins: row.embedOrigins,
    allowRestrictedEmbed: row.allowRestrictedEmbed,
  };
}

/**
 * The authorized target of a share route and who is asking: a view (its links) or a base (its
 * whole-base links, `viewId` null).
 */
export interface ShareScope {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  viewId: string | null;
  userId: string;
}

/**
 * The links of the scope's target: the view's links (view links, or form links of a form view
 * ), or the base's base links.
 */
function ofTarget(s: ShareScope) {
  return s.viewId
    ? and(inArray(shares.kind, ['view', 'form']), eq(shares.viewId, s.viewId))
    : and(eq(shares.kind, 'base'), eq(shares.baseId, s.baseId));
}

/** Whether public forms may be published: a CAPTCHA is configured, or this isn't production. */
export interface ShareOptions {
  formsReady: boolean;
}

/**
 * A form link is only the link: no password, email domains, CSV download or embedding
 * (forms answer anonymous submitters; those settings belong to read-only links).
 */
function assertFormLinkInput(input: CreateShareInput) {
  if (input.password) throw invalid('password', "A form link can't have a password yet.");
  if (input.allowedDomains?.length) {
    throw invalid('allowedDomains', "A form link can't be limited to email domains yet.");
  }
  if (input.allowDownload) throw invalid('allowDownload', 'A form link has no data to download.');
  if (input.embedOrigins?.length) {
    throw invalid('embedOrigins', "A form link can't be embedded yet.");
  }
}

/** Production without Turnstile keys can't publish a form. */
function assertFormsReady(opts: ShareOptions) {
  if (!opts.formsReady) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail:
        'Public forms need a CAPTCHA, and this server has none configured (TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY).',
    });
  }
}

/** The target's links that aren't revoked (expired ones too, until revoked), newest first. */
export async function listShares(s: ShareScope): Promise<Share[]> {
  const rows = await s.tx
    .select()
    .from(shares)
    .where(and(ofTarget(s), isNull(shares.revokedAt)))
    .orderBy(desc(shares.createdAt), desc(shares.id));
  const now = new Date();
  return rows.map((r) => toShare(r, now));
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    extensions: { errors: [{ path, message }] },
  });
}

/** A link's expiry: null for none, else in the future and within MAX_SHARE_LIFETIME_DAYS. */
function expiryOf(value: string | null | undefined, now: Date): Date | null {
  if (!value) return null;
  const expiresAt = new Date(value);
  const latest = now.getTime() + MAX_SHARE_LIFETIME_DAYS * 86_400_000;
  if (expiresAt.getTime() <= now.getTime()) {
    throw invalid('expiresAt', 'The expiry must be in the future.');
  }
  if (expiresAt.getTime() > latest) {
    throw invalid('expiresAt', `The expiry must be within ${MAX_SHARE_LIFETIME_DAYS} days.`);
  }
  return expiresAt;
}

/**
 * A new link of the view (grid, kanban, calendar, gallery, timeline or list) or of the whole base: at most
 * MAX_SHARES_PER_VIEW live ones per target, an expiry (if any) in the future, the password (if
 * any) hashed with argon2id. Answers the token, once.
 */
export async function createShare(
  s: ShareScope,
  input: CreateShareInput,
  opts: ShareOptions = { formsReady: true }
): Promise<{ share: Share; token: string }> {
  let kind: ShareKind = s.viewId ? 'view' : 'base';
  if (s.viewId) {
    const [view] = await s.tx
      .select({ type: views.type })
      .from(views)
      .where(eq(views.id, s.viewId));
    if (!view) throw new Error('view not visible under RLS');
    if (view.type === 'form') {
      // A form view's link is its public form.
      assertFormLinkInput(input);
      assertFormsReady(opts);
      kind = 'form';
    } else if (!(SHAREABLE_VIEW_TYPES as readonly string[]).includes(view.type)) {
      throw invalid('viewId', 'This type of view can’t be shared with a link.');
    }
  }
  await assertShareAllowed(s.tx, s.workspaceId, { kind, embedOrigins: input.embedOrigins });
  const now = new Date();
  const expiresAt = expiryOf(input.expiresAt, now);
  const passwordHash = input.password ? await hashSharePassword(input.password) : null;
  // Serialize link creation per target, so two requests can't both pass the cap.
  const target = s.viewId ? `share:${s.viewId}` : `share:base:${s.baseId}`;
  await s.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${target}, 0))`);
  const [live] = await s.tx
    .select({ n: count() })
    .from(shares)
    .where(and(ofTarget(s), isNull(shares.revokedAt)));
  if ((live?.n ?? 0) >= MAX_SHARES_PER_VIEW) {
    throw new AppError('CONFLICT', {
      detail: `A ${s.viewId ? 'view' : 'base'} has at most ${MAX_SHARES_PER_VIEW} share links. Revoke one first.`,
    });
  }
  const token = generateShareToken();
  const [row] = await s.tx
    .insert(shares)
    .values({
      workspaceId: s.workspaceId,
      baseId: s.baseId,
      kind,
      viewId: s.viewId,
      tokenHash: hashShareToken(token),
      passwordHash,
      allowedDomains: input.allowedDomains ?? [],
      allowCopy: input.allowCopy ?? true,
      allowDownload: input.allowDownload ?? false,
      embedOrigins: input.embedOrigins ?? [],
      allowRestrictedEmbed: input.allowRestrictedEmbed ?? false,
      createdBy: s.userId,
      expiresAt,
    })
    .returning();
  if (!row) throw new Error('create share: no row returned');
  return { share: toShare(row, now), token };
}

/**
 * Changes a link of the target (not revoked): its expiry, password, domains or toggles. A new
 * or removed password bumps `password_version`, which ends every unlock of the old one.
 */
export async function updateShare(
  s: ShareScope,
  shareId: string,
  input: UpdateShareInput
): Promise<Share> {
  const now = new Date();
  const set: Partial<typeof shares.$inferInsert> = {};
  if (input.expiresAt !== undefined) set.expiresAt = expiryOf(input.expiresAt, now);
  if (input.allowedDomains !== undefined) set.allowedDomains = input.allowedDomains;
  if (input.allowCopy !== undefined) set.allowCopy = input.allowCopy;
  if (input.allowDownload !== undefined) set.allowDownload = input.allowDownload;
  if (input.embedOrigins !== undefined) set.embedOrigins = input.embedOrigins;
  if (input.allowRestrictedEmbed !== undefined) {
    set.allowRestrictedEmbed = input.allowRestrictedEmbed;
  }
  const passwordChange =
    input.password === undefined
      ? {}
      : {
          passwordHash: input.password === null ? null : await hashSharePassword(input.password),
          passwordVersion: sql`${shares.passwordVersion} + 1`,
        };
  const which = and(eq(shares.id, shareId), ofTarget(s), isNull(shares.revokedAt));
  const [current] = await s.tx.select({ kind: shares.kind }).from(shares).where(which);
  if (!current) throw NO_SUCH_SHARE();
  if (current.kind === 'form') assertFormLinkInput(input);
  if (input.embedOrigins?.length) {
    await assertShareAllowed(s.tx, s.workspaceId, { kind: null, embedOrigins: input.embedOrigins });
  }
  const changes = { ...set, ...passwordChange };
  const [row] =
    Object.keys(changes).length === 0
      ? await s.tx.select().from(shares).where(which)
      : await s.tx.update(shares).set(changes).where(which).returning();
  if (!row) throw NO_SUCH_SHARE();
  return toShare(row, now);
}

/** Revokes a link of the target; 404 when it isn't one (or is revoked already). */
export async function revokeShare(s: ShareScope, shareId: string): Promise<void> {
  const revoked = await s.tx
    .update(shares)
    .set({ revokedAt: new Date() })
    .where(and(eq(shares.id, shareId), ofTarget(s), isNull(shares.revokedAt)))
    .returning({ id: shares.id });
  if (revoked.length === 0) throw NO_SUCH_SHARE();
}

interface ResolvedShare extends Record<string, unknown> {
  share_id: string;
  workspace_id: string;
  base_id: string;
  kind: ShareKind;
  view_id: string | null;
  token_hash: string;
  expires_at: string | Date | null;
  password_hash: string | null;
  password_version: number;
  allowed_domains: string[];
  allow_copy: boolean;
  allow_download: boolean;
  embed_origins: string[];
  allow_restricted_embed: boolean;
}

/** A live share link of one public request, in its workspace's read-only scope. */
export interface ShareContext {
  tx: Transaction;
  workspaceId: string;
  share: {
    id: string;
    kind: ShareKind;
    baseId: string;
    viewId: string | null;
    allowCopy: boolean;
    allowDownload: boolean;
    expiresAt: Date | null;
  };
}

/**
 * Runs `fn` for the live share of `token` in one read-only transaction scoped to its workspace
 * (RLS) with no user, before any access check. Unknown, revoked and expired tokens are all the
 * same 404. The stored hash is compared to the token's in constant time, beside the index
 * lookup.
 */
async function inShare<T>(
  db: Database,
  token: string,
  fn: (ctx: ShareContext, lock: ShareLock) => Promise<T>,
  opts: { kinds: readonly ShareKind[]; write?: boolean } = { kinds: READ_KINDS }
): Promise<T> {
  if (!SHARE_TOKEN_RE.test(token)) throw NO_SUCH_SHARE();
  const hash = hashShareToken(token);
  return db.transaction(
    async (tx) => {
      const { rows } = await tx.execute<ResolvedShare>(sql`SELECT * FROM share_resolve(${hash})`);
      const found = rows[0];
      if (!found || !sameHash(found.token_hash, hash)) throw NO_SUCH_SHARE();
      // A form link opens only the form routes, a read-only link only the share routes.
      if (!opts.kinds.includes(found.kind)) throw NO_SUCH_SHARE();
      await tx.execute(
        sql`SELECT set_config('app.user_id', '', true),
                   set_config('app.workspace_id', ${found.workspace_id}, true)`
      );
      const ctx: ShareContext = {
        tx,
        workspaceId: found.workspace_id,
        share: {
          id: found.share_id,
          kind: found.kind,
          baseId: found.base_id,
          viewId: found.view_id,
          allowCopy: found.allow_copy,
          allowDownload: found.allow_download,
          expiresAt: found.expires_at ? new Date(found.expires_at) : null,
        },
      };
      return fn(ctx, {
        shareId: found.share_id,
        passwordHash: found.password_hash,
        passwordVersion: found.password_version,
        allowedDomains: found.allowed_domains,
      });
    },
    { accessMode: opts.write ? 'read write' : 'read only' }
  );
}

/** The kinds of read-only links (`/api/shared/*`). */
const READ_KINDS: readonly ShareKind[] = ['view', 'base'];

/**
 * Runs `fn` for the live form link of `token` in one transaction scoped to its workspace
 * (RLS) with no user: read-only for the form itself, read-write for a submission or an upload.
 * Unknown, revoked and expired tokens, and links that aren't form links, are all the same 404.
 */
export function withFormShare<T>(
  db: Database,
  token: string,
  fn: (ctx: ShareContext) => Promise<T>,
  opts: { write?: boolean } = {}
): Promise<T> {
  return inShare(db, token, (ctx) => fn(ctx), { kinds: ['form'], write: opts.write ?? false });
}

/**
 * Runs `fn` for the live share of `token` once the request passes its checks: a signed-in
 * viewer at an allowed email domain, then the password's unlock cookie. Nothing of the share's
 * data is read before.
 */
export function withShare<T>(
  db: Database,
  token: string,
  creds: ShareCredentials,
  fn: (ctx: ShareContext) => Promise<T>
): Promise<T> {
  return inShare(db, token, async (ctx, lock) => {
    await checkShareAccess(lock, creds);
    return fn(ctx);
  });
}

/**
 * `POST /api/shared/:token/unlock`: checks the password (after the domain check, so only
 * allowed viewers may try) and answers the unlock cookie's value and expiry; null when the link
 * has no password. A wrong password is 401 SHARE_PASSWORD_INCORRECT.
 */
export function unlockShare(
  db: Database,
  token: string,
  creds: ShareCredentials,
  password: string
): Promise<{ cookie: string; expiresAt: Date } | null> {
  return inShare(db, token, async (ctx, lock) => {
    await checkShareDomain(lock, creds);
    if (lock.passwordHash === null) return null;
    if (!(await verifySharePassword(lock.passwordHash, password))) {
      throw new AppError('SHARE_PASSWORD_INCORRECT', {
        detail: 'That password isn’t right.',
        extensions: passwordPromptExtensions(creds),
      });
    }
    const expiresAt = shareAccessExpiry(ctx.share.expiresAt);
    const cookie = creds.signer.sign({
      shareId: lock.shareId,
      version: lock.passwordVersion,
      expiresAt,
    });
    return { cookie, expiresAt: new Date(expiresAt) };
  });
}

/**
 * The origins that may frame the `/embed/<token>` page of a live link (
 * `shareFrameAncestors`): none for an unknown, revoked or expired token, a link without embed
 * origins, or one with a password or email domains that wasn't explicitly allowed to be embedded.
 * Reads only the link itself (`share_resolve`), no data.
 */
export async function shareEmbedAncestors(db: Database, token: string): Promise<string[]> {
  if (!SHARE_TOKEN_RE.test(token)) return [];
  const hash = hashShareToken(token);
  const { rows } = await db.execute<ResolvedShare>(sql`SELECT * FROM share_resolve(${hash})`);
  const found = rows[0];
  if (!found || !sameHash(found.token_hash, hash) || !READ_KINDS.includes(found.kind)) return [];
  return shareFrameAncestors({
    embedOrigins: found.embed_origins,
    allowRestrictedEmbed: found.allow_restricted_embed,
    hasPassword: found.password_hash !== null,
    allowedDomains: found.allowed_domains,
  });
}

/** A shared table's views as a link lists them. */
type SharedTables = SharedShare['tables'];

/**
 * The views a link opens, by table, in sidebar order: its one view, or for a base link every
 * live table's shareable views except personal ones. A view link whose view can't be shown is
 * 404.
 */
export async function sharedViews(
  ctx: ShareContext
): Promise<{ name: string; tables: SharedTables }> {
  const shareable = SHAREABLE_VIEW_TYPES as readonly string[];
  if (ctx.share.kind === 'view') {
    const [row] = await ctx.tx
      .select({ id: views.id, name: views.name, type: views.type, table: tables.name })
      .from(views)
      .innerJoin(tables, eq(tables.id, views.tableId))
      .where(and(eq(views.id, ctx.share.viewId ?? ''), isNull(views.deletedAt)));
    if (!row || !shareable.includes(row.type)) throw NO_SUCH_SHARE();
    return {
      name: row.name,
      tables: [
        { name: row.table, views: [{ id: row.id, name: row.name, type: row.type as ViewType }] },
      ],
    };
  }
  const [base] = await ctx.tx
    .select({ name: bases.name })
    .from(bases)
    .where(eq(bases.id, ctx.share.baseId));
  if (!base) throw NO_SUCH_SHARE();
  const live = await ctx.tx
    .select({ id: tables.id, name: tables.name })
    .from(tables)
    .where(and(eq(tables.baseId, ctx.share.baseId), isNull(tables.deletedAt)))
    .orderBy(asc(tables.position), asc(tables.id));
  const rows =
    live.length === 0
      ? []
      : await ctx.tx
          .select({ id: views.id, tableId: views.tableId, name: views.name, type: views.type })
          .from(views)
          .where(
            and(
              inArray(
                views.tableId,
                live.map((t) => t.id)
              ),
              isNull(views.deletedAt),
              eq(views.personal, false),
              inArray(views.type, [...shareable])
            )
          )
          .orderBy(asc(views.position), asc(views.id));
  return {
    name: base.name,
    tables: live.flatMap((t) => {
      const list = rows
        .filter((v) => v.tableId === t.id)
        .map((v) => ({ id: v.id, name: v.name, type: v.type as ViewType }));
      return list.length > 0 ? [{ name: t.name, views: list }] : [];
    }),
  };
}

/** The share-link read of one view: the view, compiled, in its workspace's scope. */
export interface SharedContext extends SharedReadContext {
  shareId: string;
  allowDownload: boolean;
  expiresAt: Date | null;
  view: { id: string; name: string; type: string };
  table: TableRow;
  shared: SharedViewQuery;
}

/**
 * Runs `fn` for one view a link opens, once the request passes the link's checks: the link's own
 * view, or for a base link a live, shareable, non-personal view of a live table of the base.
 * Anything else (another base's view, a personal or deleted one) is 404, like an unknown link.
 */
export function withSharedView<T>(
  db: Database,
  token: string,
  creds: ShareCredentials,
  viewId: string,
  fn: (ctx: SharedContext) => Promise<T>
): Promise<T> {
  return withShare(db, token, creds, async (ctx) => {
    const { share, tx } = ctx;
    if (share.kind === 'view' && share.viewId !== viewId) throw NO_SUCH_VIEW();
    const [view] = await tx
      .select({
        id: views.id,
        tableId: views.tableId,
        name: views.name,
        type: views.type,
        config: views.config,
        personal: views.personal,
        baseId: tables.baseId,
      })
      .from(views)
      .innerJoin(tables, and(eq(tables.id, views.tableId), isNull(tables.deletedAt)))
      .where(and(eq(views.id, viewId), isNull(views.deletedAt)));
    if (
      !view ||
      view.baseId !== share.baseId ||
      (share.kind === 'base' && view.personal) ||
      !(SHAREABLE_VIEW_TYPES as readonly string[]).includes(view.type)
    ) {
      throw NO_SUCH_VIEW();
    }
    const table = await loadTable(tx, view.tableId);
    const read = { tx, workspaceId: ctx.workspaceId, table };
    const shared = await compileSharedView(read, view);
    return fn({
      ...read,
      shareId: share.id,
      allowDownload: share.allowDownload,
      expiresAt: share.expiresAt,
      view: { id: view.id, name: view.name, type: view.type },
      shared,
    });
  });
}

const NO_SUCH_VIEW = () => new AppError('NOT_FOUND', { detail: 'No such view in this link.' });

function sameHash(stored: string, computed: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(computed, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
