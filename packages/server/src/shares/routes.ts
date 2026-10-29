import { randomUUID } from 'node:crypto';
import {
  contracts,
  csvLine,
  downloads,
  getFieldType,
  neutralizeCell,
  publicFieldOptions,
  SHARED_CSV_MAX_RECORDS,
  type Share,
  type SharedView,
} from '@openrows/shared';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { signedDownload } from '../attachments/service.js';
import type { ObjectStore } from '../attachments/storage.js';
import { audit } from '../audit/record.js';
import { clientIp } from '../auth/client-ip.js';
import { rateLimit } from '../auth/rate-limit.js';
import { SESSION_COOKIE } from '../auth/session-token.js';
import type { SessionStore } from '../auth/sessions.js';
import type { ResourceEnv } from '../authz/middleware.js';
import type { RouteRegistry } from '../authz/routes.js';
import { clientIndex } from '../client.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { fieldType } from '../fields/service.js';
import { type CaptchaVerifier, turnstileVerifier } from '../forms/turnstile.js';
import { safeFileName } from '../import-export/export.js';
import type { AppEnv } from '../lib/context.js';
import { AppError, notFound } from '../lib/errors.js';
import { sharedRecords, sharedViewHasFile } from '../records/service.js';
import { SHARE_ACCESS_COOKIE, type ShareCredentials, shareCookieSigner } from './access.js';
import {
  createShare,
  hashShareToken,
  listShares,
  revokeShare,
  type SharedContext,
  type ShareOptions,
  type ShareScope,
  sharedViews,
  shareEmbedAncestors,
  unlockShare,
  updateShare,
  withShare,
  withSharedView,
} from './service.js';

function viewScopeOf(c: Context<ResourceEnv<'view'>>): ShareScope {
  const { tx, resource, principal } = c.var;
  if (!resource.baseId) throw new Error('view without a base');
  return {
    tx,
    workspaceId: resource.workspaceId,
    baseId: resource.baseId,
    viewId: resource.id,
    userId: principal.user.id,
  };
}

function baseScopeOf(c: Context<ResourceEnv<'base'>>): ShareScope {
  const { tx, resource, principal } = c.var;
  return {
    tx,
    workspaceId: resource.workspaceId,
    baseId: resource.id,
    viewId: null,
    userId: principal.user.id,
  };
}

/**
 * Share links: a view's (`view:share`) and a whole base's (`base:share`), creators and
 * owners of the workspace or base: list, make, change and revoke them. A personal view resolves
 * only for its maker, so only they share it.
 */
export function shareRoutes(routes: RouteRegistry, opts: ShareOptions = { formsReady: true }) {
  const s = contracts.shares;
  const view = { resource: 'view', action: 'view:share' } as const;
  /** What the audit log keeps of a link: its settings, never its token or password. */
  const shareSummary = (share: Share) => ({
    kind: share.kind,
    viewId: share.viewId,
    expiresAt: share.expiresAt,
    hasPassword: share.hasPassword,
    allowedDomains: share.allowedDomains,
    allowCopy: share.allowCopy,
    allowDownload: share.allowDownload,
    embedOrigins: share.embedOrigins,
  });
  const auditShare = (
    c: Context<ResourceEnv<'view'>> | Context<ResourceEnv<'base'>>,
    scope: ShareScope,
    action: 'share.create' | 'share.update',
    share: Share
  ) =>
    audit(c, scope.tx, {
      workspaceId: scope.workspaceId,
      action,
      target: { type: 'share', id: share.id },
      summary: { after: { baseId: share.baseId, ...shareSummary(share) } },
    });
  const auditRevoke = (
    c: Context<ResourceEnv<'view'>> | Context<ResourceEnv<'base'>>,
    scope: ShareScope,
    shareId: string
  ) =>
    audit(c, scope.tx, {
      workspaceId: scope.workspaceId,
      action: 'share.revoke',
      target: { type: 'share', id: shareId },
      summary: { before: { baseId: scope.baseId, viewId: scope.viewId } },
    });

  routes.endpoint(s.list, view, async (c) => ({ shares: await listShares(viewScopeOf(c)) }));
  routes.endpoint(s.create, view, async (c, { body }) => {
    const scope = viewScopeOf(c);
    const created = await createShare(scope, body, opts);
    await auditShare(c, scope, 'share.create', created.share);
    return created;
  });
  routes.endpoint(s.update, view, async (c, { params, body }) => {
    const scope = viewScopeOf(c);
    const share = await updateShare(scope, params.shareId, body);
    await auditShare(c, scope, 'share.update', share);
    return share;
  });
  routes.endpoint(s.revoke, view, async (c, { params }) => {
    const scope = viewScopeOf(c);
    await revokeShare(scope, params.shareId);
    await auditRevoke(c, scope, params.shareId);
    return null;
  });

  const base = { resource: 'base', action: 'base:share' } as const;
  routes.endpoint(s.listBase, base, async (c) => ({ shares: await listShares(baseScopeOf(c)) }));
  routes.endpoint(s.createBase, base, async (c, { body }) => {
    const scope = baseScopeOf(c);
    const created = await createShare(scope, body);
    await auditShare(c, scope, 'share.create', created.share);
    return created;
  });
  routes.endpoint(s.updateBase, base, async (c, { params, body }) => {
    const scope = baseScopeOf(c);
    const share = await updateShare(scope, params.shareId, body);
    await auditShare(c, scope, 'share.update', share);
    return share;
  });
  routes.endpoint(s.revokeBase, base, async (c, { params }) => {
    const scope = baseScopeOf(c);
    await revokeShare(scope, params.shareId);
    await auditRevoke(c, scope, params.shareId);
    return null;
  });
}

/** The token segment of `/api/shared/<token>/...`. */
const tokenOf = (c: Context) => c.req.path.split('/')[3] ?? '';

/** Unlock attempts per link and client IP, and per link, in UNLOCK_WINDOW_MS. */
export const UNLOCK_LIMIT_PER_IP = 10;
export const UNLOCK_LIMIT_PER_SHARE = 100;
const UNLOCK_WINDOW_MS = 15 * 60_000;

/**
 * The public side of share links: no session needed, the token in the path is the
 * credential. Rate-limited per client IP and per token (its hash), and password attempts per
 * token and IP (with Turnstile keys, each attempt also needs a CAPTCHA). Every read first passes the link's domain and password checks (`withShare`);
 * the JSON answers are a strict projection of each view (`compileSharedView`, `sharedRecords`);
 * files redirect to short-lived signed URLs, only for files the view shows. Unknown, revoked and
 * expired tokens are the same 404. The headers (no-referrer, noindex, no-store) are set for these
 * paths in lib/security-headers.ts.
 */
export function sharedRoutes(
  routes: RouteRegistry,
  deps: {
    db: Database;
    config: Config;
    store: ObjectStore | undefined;
    sessions: SessionStore;
    /** Turnstile on password attempts; by default config.turnstile's, else none. */
    captcha?: CaptchaVerifier | undefined;
  }
) {
  const { db, config, sessions } = deps;
  const verifyCaptcha =
    deps.captcha ?? (config.turnstile ? turnstileVerifier(config.turnstile.secretKey) : undefined);
  const captchaSiteKey = verifyCaptcha ? (config.turnstile?.siteKey ?? null) : null;
  const ip = (c: Context) =>
    clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops }) ?? 'unknown';
  const signer = shareCookieSigner(config.encryptionKey);
  const secure = config.appUrl.startsWith('https:');
  const creds = (c: Context<AppEnv>): ShareCredentials => ({
    cookie: getCookie(c, SHARE_ACCESS_COOKIE),
    viewer: async () => {
      const token = getCookie(c, SESSION_COOKIE);
      const principal = token ? await sessions.resolve(token, c.get('logger')) : null;
      return principal?.user ?? null;
    },
    signer,
    captchaSiteKey,
  });

  routes.use(
    '/api/shared/*',
    rateLimit({ limit: config.shareRateLimit, windowMs: 60_000, key: (c) => `ip:${ip(c)}` })
  );
  routes.use(
    '/api/shared/*',
    rateLimit({
      limit: config.shareRateLimit * 5,
      windowMs: 60_000,
      key: (c) => `token:${hashShareToken(tokenOf(c))}`,
    })
  );
  // Password guesses: per link and IP, and per link from everywhere. Counted before the
  // argon2 check, so a flood costs no hashing.
  routes.use(
    '/api/shared/:shareToken/unlock',
    rateLimit({
      limit: UNLOCK_LIMIT_PER_IP,
      windowMs: UNLOCK_WINDOW_MS,
      key: (c) => `unlock:${hashShareToken(tokenOf(c))}:${ip(c)}`,
    })
  );
  routes.use(
    '/api/shared/:shareToken/unlock',
    rateLimit({
      limit: UNLOCK_LIMIT_PER_SHARE,
      windowMs: UNLOCK_WINDOW_MS,
      key: (c) => `unlock:${hashShareToken(tokenOf(c))}`,
    })
  );

  // The embed page of a link: the client's index.html, framed only by the link's embed
  // origins (frame-ancestors; lib/security-headers.ts). The page reads the link through the
  // same public API as /s/<token>, so every other check (password, domains, revocation) holds.
  // Without a built client (tests, `npm run dev` through Vite) there is no page to serve.
  const index = config.clientDir ? clientIndex(config.clientDir) : undefined;
  routes.use(
    '/embed/*',
    rateLimit({ limit: config.shareRateLimit, windowMs: 60_000, key: (c) => `ip:${ip(c)}` })
  );
  routes.public('GET', '/embed/:shareToken', async (c) => {
    if (!index) return notFound(c);
    const ancestors = await shareEmbedAncestors(db, c.req.param('shareToken') ?? '');
    const page = await index(c, async () => {});
    if (!page) return notFound(c);
    c.set('frameAncestors', ancestors);
    return page;
  });

  const p = contracts.shared;
  routes.endpoint(p.share, 'public', async (c, { params }) =>
    withShare(db, params.shareToken, creds(c), async (ctx) => ({
      kind: ctx.share.kind,
      ...(await sharedViews(ctx)),
      allowCopy: ctx.share.allowCopy,
      allowDownload: ctx.share.allowDownload,
      expiresAt: ctx.share.expiresAt?.toISOString() ?? null,
    }))
  );

  routes.endpoint(p.unlock, 'public', async (c, { params, body }) => {
    if (verifyCaptcha) {
      // Checked before the password: a bot's guesses cost no argon2 and no database work.
      const passed = body.captchaToken
        ? await verifyCaptcha({
            token: body.captchaToken,
            remoteIp: ip(c),
            idempotencyKey: randomUUID(),
          })
        : false;
      if (!passed) {
        throw new AppError('CAPTCHA_FAILED', {
          detail: 'The CAPTCHA check failed. Try it again, then enter the password.',
          extensions: captchaSiteKey ? { captchaSiteKey } : {},
        });
      }
    }
    const unlocked = await unlockShare(db, params.shareToken, creds(c), body.password);
    if (unlocked) {
      // Scoped to this link's paths, so it is never sent anywhere else; it also names the share.
      setCookie(c, SHARE_ACCESS_COOKIE, unlocked.cookie, {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: `/api/shared/${params.shareToken}`,
        expires: unlocked.expiresAt,
      });
    }
    return null;
  });

  routes.endpoint(p.view, 'public', async (c, { params }) =>
    withSharedView(db, params.shareToken, creds(c), params.viewId, async (ctx) => {
      const ids = new Set(ctx.shared.fields.map((f) => f.row.id));
      const { fieldOrder, columnWidths, frozenCount, rowHeight } = ctx.shared.layout;
      const { kanban, calendar, gallery, timeline, list } = ctx.shared.shape;
      return {
        view: { name: ctx.view.name, type: ctx.view.type as SharedView['view']['type'] },
        table: { name: ctx.table.name },
        fields: ctx.shared.fields.map((f) => ({
          id: f.row.id,
          name: f.row.name,
          type: fieldType(f.row),
          options: publicFieldOptions(fieldType(f.row), f.row.config),
          isPrimary: f.row.isPrimary,
        })),
        layout: {
          ...(fieldOrder ? { fieldOrder: fieldOrder.filter((id) => ids.has(id)) } : {}),
          ...(columnWidths
            ? {
                columnWidths: Object.fromEntries(
                  Object.entries(columnWidths).filter(([id]) => ids.has(id))
                ),
              }
            : {}),
          ...(frozenCount !== undefined ? { frozenCount } : {}),
          ...(rowHeight ? { rowHeight } : {}),
        },
        // The layout of a kanban, calendar, gallery, timeline or list: only shown fields.
        ...(kanban ? { kanban } : {}),
        ...(calendar ? { calendar } : {}),
        ...(gallery ? { gallery } : {}),
        ...(timeline ? { timeline } : {}),
        ...(list ? { list } : {}),
        expiresAt: ctx.expiresAt?.toISOString() ?? null,
      };
    })
  );

  routes.endpoint(p.records, 'public', async (c, { params, query }) =>
    withSharedView(db, params.shareToken, creds(c), params.viewId, (ctx) =>
      sharedRecords(ctx, ctx.shared, query)
    )
  );

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const noSuchView = () => new AppError('NOT_FOUND', { detail: 'No such view in this link.' });
  for (const [download, thumbnail] of [
    [downloads.sharedAttachment, false],
    [downloads.sharedAttachmentThumbnail, true],
  ] as const) {
    routes.public(download.method, download.path, async (c) => {
      const shareToken = c.req.param('shareToken') ?? '';
      const viewId = c.req.param('viewId') ?? '';
      const id = c.req.param('attachmentId') ?? '';
      if (!uuid.test(viewId)) throw noSuchView();
      const url = await withSharedView(db, shareToken, creds(c), viewId, async (ctx) => {
        if (!uuid.test(id) || !(await sharedViewHasFile(ctx, ctx.shared, id))) {
          throw new AppError('NOT_FOUND', { detail: 'No such file in this view.' });
        }
        return signedDownload(ctx, deps.store, id, thumbnail);
      });
      c.header('cache-control', 'private, no-store');
      c.header('referrer-policy', 'no-referrer');
      return c.redirect(url, 302);
    });
  }

  // A view as CSV, only when the link allows downloads.
  routes.public(downloads.sharedCsv.method, downloads.sharedCsv.path, async (c) => {
    const shareToken = c.req.param('shareToken') ?? '';
    const viewId = c.req.param('viewId') ?? '';
    if (!uuid.test(viewId)) throw noSuchView();
    const { filename, text } = await withSharedView(db, shareToken, creds(c), viewId, (ctx) =>
      sharedCsv(ctx)
    );
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    c.header('cache-control', 'private, no-store');
    return c.body(text);
  });
}

/**
 * A shared view as CSV text: the projection of `sharedRecords` (links and people as
 * names), its visible fields in order, display text per the registry, every cell guarded against
 * formula injection; at most SHARED_CSV_MAX_RECORDS records, read in the request's one read-only
 * transaction.
 */
async function sharedCsv(ctx: SharedContext): Promise<{ filename: string; text: string }> {
  if (!ctx.allowDownload) {
    throw new AppError('SHARE_DOWNLOAD_DISABLED', {
      detail: 'This link doesn’t allow downloading its data.',
    });
  }
  const order = ctx.shared.layout.fieldOrder ?? [];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const fields = [...ctx.shared.fields].sort(
    (a, b) => Number(b.row.isPrimary) - Number(a.row.isPrimary) || rank(a.row.id) - rank(b.row.id)
  );
  const columns = fields.map((f) => {
    const def = getFieldType(fieldType(f.row));
    const names = Boolean(f.link) || def.category === 'people';
    return { id: f.row.id, def, names, options: def.optionsSchema.parse(f.row.config ?? {}) };
  });
  // A BOM, so Excel reads the file as UTF-8.
  let text = `\uFEFF${csvLine(fields.map((f) => neutralizeCell(f.row.name)))}`;
  const page = 1000;
  for (let offset = 0; offset < SHARED_CSV_MAX_RECORDS; offset += page) {
    const { records } = await sharedRecords(ctx, ctx.shared, {
      offset,
      limit: Math.min(page, SHARED_CSV_MAX_RECORDS - offset),
    });
    for (const r of records) {
      text += csvLine(
        columns.map((col) => {
          const value = r.fields[col.id] ?? null;
          const shown = col.names
            ? Array.isArray(value)
              ? value.join(', ')
              : ''
            : col.def.format(value as never, col.options as never);
          return neutralizeCell(shown);
        })
      );
    }
    if (records.length < page) break;
  }
  return { filename: `${safeFileName(`${ctx.table.name} - ${ctx.view.name}`)}.csv`, text };
}
