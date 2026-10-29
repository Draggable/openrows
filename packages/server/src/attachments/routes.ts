import { contracts, downloads } from '@openrows/shared';
import type { Context } from 'hono';
import type { RouteRegistry } from '../authz/routes.js';
import { loadTable } from '../tables/service.js';
import {
  confirmUpload,
  createUpload,
  signedDownload,
  storageUsage,
  toValue,
  type UploadScanning,
} from './service.js';
import type { ObjectStore } from './storage.js';
import type { ThumbnailJobs } from './thumbnails.js';

/**
 * Attachments: announce a file (`attachment:create`, editors and up, base roles
 * included), PUT it to the presigned URL, confirm it, then write its value into a cell through
 * the RecordService. Downloads (`record:read`) redirect to short-lived signed URLs.
 */
export function attachmentRoutes(
  routes: RouteRegistry,
  deps: {
    store: ObjectStore | undefined;
    thumbnails: ThumbnailJobs;
    /** Malware scanning (CLAMAV_URL); the worker makes the thumbnail after the scan. */
    scanning?: UploadScanning | undefined;
  }
) {
  const a = contracts.attachments;

  routes.endpoint(
    a.create,
    { resource: 'table', action: 'attachment:create' },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      const table = await loadTable(tx, resource.id);
      return createUpload(
        { tx, table, workspaceId: resource.workspaceId, userId: principal.user.id },
        deps.store,
        body,
        await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx)
      );
    }
  );

  routes.endpoint(
    a.confirm,
    { resource: 'table', action: 'attachment:create' },
    async (c, { params }) => {
      const { tx, resource, principal } = c.var;
      const table = await loadTable(tx, resource.id);
      const scope = { workspaceId: resource.workspaceId, userId: principal.user.id };
      const { row, confirmed } = await confirmUpload(
        { tx, table, ...scope },
        deps.store,
        params.attachmentId,
        deps.scanning
      );
      if (confirmed && row.status === 'ready') {
        deps.thumbnails.enqueue({ ...scope, attachmentId: row.id });
      }
      return toValue(row);
    }
  );

  routes.endpoint(a.usage, { resource: 'workspace', action: 'workspace:read' }, (c) =>
    storageUsage(c.var.tx, c.var.resource.id)
  );

  const redirect = (c: Context, url: string) => {
    c.header('cache-control', 'private, max-age=60');
    c.header('referrer-policy', 'no-referrer');
    return c.redirect(url, 302);
  };

  for (const [download, thumbnail] of [
    [downloads.attachment, false],
    [downloads.attachmentThumbnail, true],
  ] as const) {
    routes.resource(
      download.method,
      download.path,
      { resource: 'table', action: 'record:read' },
      async (c) => {
        const { tx, resource } = c.var;
        const id = c.req.param('attachmentId') ?? '';
        const table = await loadTable(tx, resource.id);
        const url = await signedDownload(
          { tx, table, workspaceId: resource.workspaceId },
          deps.store,
          id,
          thumbnail
        );
        return redirect(c, url);
      }
    );
  }
}
