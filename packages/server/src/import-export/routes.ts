import { contracts, downloads, MAX_IMPORT_BYTES } from '@openrows/shared';
import { bodyLimit } from 'hono/body-limit';
import { audit } from '../audit/record.js';
import type { RouteRegistry } from '../authz/routes.js';
import type { Database } from '../db/index.js';
import type { Jobs } from '../jobs/send.js';
import { loadOwnJob } from '../jobs/status.js';
import { AppError } from '../lib/errors.js';
import { loadTable } from '../tables/service.js';
import { assertRecordRoom } from '../usage/quota.js';
import { exportCsv } from './export.js';
import { planImport, startImport, toImportJob } from './import.js';

/** JSON around a 50 MB CSV: escaping makes it somewhat bigger. */
const IMPORT_BODY_LIMIT = Math.ceil(MAX_IMPORT_BYTES * 1.25);

/**
 * CSV import into a table and CSV export of a view. Importing needs `record:create` (and
 * `field:create` to map columns to new fields) and runs in the worker; only who started
 * an import reads its progress. Exporting needs `record:read`.
 */
export function importExportRoutes(routes: RouteRegistry, deps: { db: Database; jobs: Jobs }) {
  const i = contracts.imports;

  routes.use(
    i.create.path,
    bodyLimit({
      maxSize: IMPORT_BODY_LIMIT,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', { detail: 'A CSV import takes up to 50 MB.' });
      },
    })
  );

  routes.endpoint(
    i.create,
    { resource: 'table', action: 'record:create', token: null },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      const table = await loadTable(tx, resource.id);
      const who = { role: resource.role, userId: principal.user.id };
      const plan = await planImport(tx, table, who, body);
      // The plan's records per base: an import that can't fit is refused before it starts
      // (the worker checks each batch again).
      await assertRecordRoom(
        tx,
        await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx),
        table.baseId,
        plan.rows.length
      );
      return startImport(
        tx,
        deps.jobs,
        { workspaceId: resource.workspaceId, userId: who.userId },
        table,
        plan,
        body
      );
    }
  );

  routes.endpoint(
    i.get,
    { resource: 'table', action: 'record:create', token: null },
    async (c, { params }) => {
      const { tx, resource, principal } = c.var;
      const job = await loadOwnJob(
        tx,
        { id: params.importId, kind: 'import', userId: principal.user.id, tableId: resource.id },
        'No such import.'
      );
      return toImportJob(job);
    }
  );

  const csv = downloads.tableCsv;
  routes.resource(csv.method, csv.path, { resource: 'table', action: 'record:read' }, async (c) => {
    const { tx, resource, principal } = c.var;
    const input = csv.query.parse(c.req.query());
    const table = await loadTable(tx, resource.id);
    const { filename, stream } = await exportCsv(
      deps.db,
      tx,
      { workspaceId: resource.workspaceId, userId: principal.user.id },
      table,
      input,
      c.var.logger,
      {
        workspaceId: resource.workspaceId,
        bases: resource.workspaceRole ? 'all' : resource.baseId ? [resource.baseId] : [],
        emails: resource.workspaceRole !== null,
      }
    );
    await audit(c, tx, {
      workspaceId: resource.workspaceId,
      action: 'export.csv',
      target: { type: 'table', id: table.id, name: table.name },
      summary: { after: { baseId: table.baseId, viewId: input.viewId ?? null } },
    });
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_');
    return c.body(stream, 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
  });
}
