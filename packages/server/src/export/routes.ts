import { BRAND, downloads } from '@openrows/shared';
import type { Context } from 'hono';
import type { ObjectStore } from '../attachments/storage.js';
import { audit } from '../audit/record.js';
import type { RouteRegistry } from '../authz/routes.js';
import type { Database } from '../db/index.js';
import { safeFileName } from '../import-export/export.js';
import { AppError } from '../lib/errors.js';
import { planAccountExport } from './account.js';
import { planBaseExport } from './base.js';
import { zipStream } from './zip.js';

/** Exports a user may start per window, both kinds together. */
export const EXPORT_LIMIT = { count: 10, windowMs: 10 * 60_000 };

/** A per-user fixed window (in memory, like the other limiters). */
export class ExportLimiter {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly opts: { count: number; windowMs: number } = EXPORT_LIMIT,
    private readonly now: () => number = Date.now
  ) {}

  /** Counts an export of `userId`'s; 429 past the limit. */
  take(userId: string): void {
    const t = this.now();
    for (const [k, w] of this.#windows) if (w.resetAt <= t) this.#windows.delete(k);
    const w = this.#windows.get(userId) ?? { count: 0, resetAt: t + this.opts.windowMs };
    if (w.count >= this.opts.count) {
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many exports. Try again in a few minutes.',
        extensions: { retryAfter: Math.ceil((w.resetAt - t) / 1000) },
      });
    }
    w.count += 1;
    this.#windows.set(userId, w);
  }
}

function zipResponse(c: Context, filename: string, stream: ReadableStream<Uint8Array>): Response {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return c.body(stream, 200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
}

const day = () => new Date().toISOString().slice(0, 10);

/**
 * Data export: a whole base for anyone who can read it (`base:read`: what they can read,
 * personal views of others left out) and the caller's own account data (session). Both stream a
 * ZIP built as the client reads it; rate-limited per user.
 */
export function exportRoutes(
  routes: RouteRegistry,
  deps: { db: Database; store: ObjectStore | undefined; limiter?: ExportLimiter }
) {
  const limiter = deps.limiter ?? new ExportLimiter();

  const base = downloads.baseExport;
  routes.resource(
    base.method,
    base.path,
    { resource: 'base', action: 'base:read', token: null },
    async (c) => {
      const { tx, resource, principal } = c.var;
      const query = base.query.parse(c.req.query());
      const scope = { workspaceId: resource.workspaceId, userId: principal.user.id };
      limiter.take(principal.user.id);
      const plan = await planBaseExport(deps.db, tx, scope, resource.id, deps.store, {
        attachments: query.attachments,
        directory: {
          workspaceId: resource.workspaceId,
          bases: resource.workspaceRole ? 'all' : [resource.id],
          emails: resource.workspaceRole !== null,
        },
        onMissingFile: (attachmentId, err) =>
          c.var.logger.warn({ err, attachmentId }, 'export: attachment not in storage'),
      });
      const logger = c.var.logger;
      logger.info({ baseId: resource.id }, 'base export started');
      await audit(c, tx, {
        workspaceId: resource.workspaceId,
        action: 'export.base',
        target: { type: 'base', id: resource.id, name: plan.baseName },
        summary: { after: { attachments: query.attachments } },
      });
      const stream = zipStream(plan.entries(''), (err) =>
        logger.error({ err, baseId: resource.id }, 'base export failed')
      );
      return zipResponse(c, `${safeFileName(plan.baseName)} ${day()}.zip`, stream);
    }
  );

  const account = downloads.accountExport;
  routes.session(account.method, account.path, async (c) => {
    const userId = c.var.principal.user.id;
    const query = account.query.parse(c.req.query());
    limiter.take(userId);
    const logger = c.var.logger;
    const plan = await planAccountExport(deps.db, userId, deps.store, {
      ...query,
      onMissingFile: (attachmentId, err) =>
        logger.warn({ err, attachmentId }, 'export: attachment not in storage'),
    });
    logger.info('account export started');
    const stream = zipStream(plan.entries(), (err) =>
      logger.error({ err }, 'account export failed')
    );
    return zipResponse(c, `${BRAND} account data ${day()}.zip`, stream);
  });
}
