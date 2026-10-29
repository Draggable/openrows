import { contracts, roleAllows } from '@openrows/shared';
import { eq } from 'drizzle-orm';
import type { ObjectStore } from '../attachments/storage.js';
import type { RouteRegistry } from '../authz/routes.js';
import { type Database, workspaces } from '../db/index.js';
import type { Jobs } from '../jobs/send.js';
import { loadOwnJob } from '../jobs/status.js';
import { AppError } from '../lib/errors.js';
import { startRestore, toRestoreJob } from './restore-job.js';
import {
  assertRoom,
  deleteSnapshot,
  listSnapshots,
  loadSnapshot,
  needStore,
  retentionDays,
  toSnapshot,
} from './service.js';
import { takeSnapshot } from './writer.js';

/**
 * Base snapshots, for creators and up of the base (`base:snapshot`): list, "Snapshot now",
 * restore to a new base (which also needs `base:create` on the workspace: a base-only creator
 * can't add bases; it runs in the worker, and its starter polls it) and delete. The retention is the workspace's, changed by its owners.
 */
export function snapshotRoutes(
  routes: RouteRegistry,
  deps: { db: Database; store: ObjectStore | undefined; jobs: Jobs }
) {
  const s = contracts.snapshots;

  routes.endpoint(s.list, { resource: 'base', action: 'base:snapshot' }, (c) =>
    listSnapshots(c.var.tx, c.var.resource.workspaceId, c.var.resource.id)
  );

  routes.endpoint(s.create, { resource: 'base', action: 'base:snapshot' }, async (c) => {
    const { tx, resource, principal } = c.var;
    const store = needStore(deps.store);
    await assertRoom(tx, resource.id);
    const row = await takeSnapshot(deps.db, store, {
      workspaceId: resource.workspaceId,
      baseId: resource.id,
      userId: principal.user.id,
      kind: 'manual',
    });
    c.var.logger.info(
      { baseId: resource.id, snapshotId: row.id, records: row.recordCount, size: row.size },
      'base snapshot taken'
    );
    return toSnapshot(row, await retentionDays(tx, resource.workspaceId));
  });

  routes.endpoint(
    s.restore,
    { resource: 'base', action: 'base:snapshot' },
    async (c, { params, body }) => {
      const { tx, resource, principal } = c.var;
      const role = resource.workspaceRole;
      if (!role || !roleAllows(role, 'base:create')) {
        throw new AppError('FORBIDDEN', {
          detail: 'Only creators of the workspace can restore a snapshot to a new base.',
        });
      }
      needStore(deps.store);
      // Checked here for a 404 now; the worker loads it again (it may be deleted meanwhile).
      await loadSnapshot(tx, resource.id, params.snapshotId);
      return startRestore(
        tx,
        deps.jobs,
        { workspaceId: resource.workspaceId, userId: principal.user.id, baseId: resource.id },
        { snapshotId: params.snapshotId, name: body.name }
      );
    }
  );

  routes.endpoint(
    s.restoreStatus,
    { resource: 'base', action: 'base:snapshot' },
    async (c, { params }) => {
      const { tx, resource, principal } = c.var;
      const job = await loadOwnJob(
        tx,
        { id: params.restoreId, kind: 'restore', userId: principal.user.id, baseId: resource.id },
        'No such restore.'
      );
      return toRestoreJob(job);
    }
  );

  routes.endpoint(
    s.delete,
    { resource: 'base', action: 'base:snapshot' },
    async (c, { params }) => {
      const row = await loadSnapshot(c.var.tx, c.var.resource.id, params.snapshotId);
      await deleteSnapshot(c.var.tx, deps.store, row);
      return null;
    }
  );

  routes.endpoint(
    s.updateSettings,
    { resource: 'workspace', action: 'workspace:update' },
    async (c, { body }) => {
      const [row] = await c.var.tx
        .update(workspaces)
        .set({ snapshotRetentionDays: body.retentionDays })
        .where(eq(workspaces.id, c.var.resource.id))
        .returning({ retentionDays: workspaces.snapshotRetentionDays });
      if (!row) throw new AppError('NOT_FOUND', { detail: 'No such workspace.' });
      return row;
    }
  );
}
