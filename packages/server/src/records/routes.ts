import { contracts } from '@openrows/shared';
import type { Context } from 'hono';
import type { ResourceEnv } from '../authz/middleware.js';
import { principalMay } from '../authz/policy.js';
import type { RouteRegistry } from '../authz/routes.js';
import { loadTable } from '../tables/service.js';
import {
  createRecords,
  deleteRecords,
  getRecord,
  listRecords,
  queryRecords,
  type RecordContext,
  restoreRecords,
  updateRecords,
} from './service.js';

/** The RecordService's context for an authorized table route. */
async function contextOf(
  c: Context<ResourceEnv<'table'>>,
  body: { clientOpId?: string; typecast?: boolean } = {}
) {
  const { tx, resource, principal } = c.var;
  const ctx: RecordContext = {
    tx,
    workspaceId: resource.workspaceId,
    userId: principal.user.id,
    table: await loadTable(tx, resource.id),
    clientOpId: body.clientOpId,
    typecast: body.typecast,
    role: resource.role,
    // New select options are a schema change: a token needs schema.bases:write.
    mayAddChoices: principalMay(principal, resource.role, 'field:update'),
    entitlements: await c.var.edition.entitlements.forWorkspace(resource.workspaceId, tx),
  };
  return ctx;
}

/**
 * Records of a table. Every route is authorized on the table in its path, and every record id
 * is looked up in that table's record table only, so no id from another table or workspace can
 * match (no IDOR, C9). Bulk routes take up to 1,000 records in one transaction.
 */
export function recordRoutes(routes: RouteRegistry) {
  const r = contracts.records;
  const read = { resource: 'table', action: 'record:read' } as const;

  routes.endpoint(r.list, read, async (c, { query }) => listRecords(await contextOf(c), query));

  routes.endpoint(r.create, { resource: 'table', action: 'record:create' }, async (c, { body }) => {
    const ctx = await contextOf(c, body);
    if ('records' in body) {
      return {
        records: await createRecords(
          ctx,
          body.records.map((rec) => rec.fields)
        ),
      };
    }
    const [record] = await createRecords(ctx, [body.fields]);
    if (!record) throw new Error('create record: no record returned');
    return record;
  });

  routes.endpoint(
    r.updateMany,
    { resource: 'table', action: 'record:update' },
    async (c, { body }) => ({
      records: await updateRecords(await contextOf(c, body), body.records),
    })
  );

  // A read with a body (the query is too big for a URL): any role that can read records.
  routes.endpoint(r.query, read, async (c, { body }) => queryRecords(await contextOf(c), body));

  routes.endpoint(
    r.deleteMany,
    { resource: 'table', action: 'record:delete' },
    async (c, { body }) => ({
      records: await deleteRecords(await contextOf(c, body), body.recordIds),
    })
  );

  routes.endpoint(
    r.restoreMany,
    { resource: 'table', action: 'record:delete' },
    async (c, { body }) => ({
      records: await restoreRecords(await contextOf(c, body), body.recordIds),
    })
  );

  routes.endpoint(r.get, read, async (c, { params }) =>
    getRecord(await contextOf(c), params.recordId)
  );

  routes.endpoint(
    r.update,
    { resource: 'table', action: 'record:update' },
    async (c, { params, body }) => {
      const [record] = await updateRecords(await contextOf(c, body), [
        { id: params.recordId, fields: body.fields, ifVersion: body.ifVersion },
      ]);
      if (!record) throw new Error('update record: no record returned');
      return record;
    }
  );

  routes.endpoint(
    r.delete,
    { resource: 'table', action: 'record:delete' },
    async (c, { params }) => {
      await deleteRecords(await contextOf(c), [params.recordId]);
      return null;
    }
  );
}
