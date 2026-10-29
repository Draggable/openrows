import { contracts, MAX_COMMENTS_PER_RECORD, type TokenScope } from '@openrows/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { assertAllowed, authorize } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import type { RouteRegistry } from '../authz/routes.js';
import { type V1AutomationDeps, v1AutomationRoutes } from '../automations/v1.js';
import { type CommentContext, createComment, listComments } from '../comments/service.js';
import { bases, type Database } from '../db/index.js';
import { createField, updateField } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { createRecords, deleteRecords } from '../records/service.js';
import { createTable, loadField, loadTable } from '../tables/service.js';
import { type WebhookRouteDeps, webhookRoutes } from '../webhooks/routes.js';
import { v1Errors } from './errors.js';
import { fieldInput, listV1Bases, toV1Field, v1Tables } from './meta.js';
import {
  authorizeTable,
  collaborators,
  FieldKeys,
  getV1Record,
  listV1Records,
  present,
  updateV1Records,
  type V1Env,
  writeContext,
  writesOf,
} from './records.js';

export interface V1Deps {
  db: Database;
  appUrl: string;
  webhooks: WebhookRouteDeps;
  /** Automations: listed, switched and triggered; their runs queued for the worker. */
  automations: V1AutomationDeps;
}

/**
 * The public REST API v1, Airtable's Web API shape. Every route is a resource route on the
 * base in its path (`withResource`: 404 outside the caller's tenancy or token grants), with the
 * token scope of what it does; the table it names (by id or name, only in that base) is then
 * authorized for the table action in `authorizeTable`. Records go through the RecordService and
 * the query engine, comments through the comment service, schema writes through the table and
 * field services: nothing here writes data itself.
 */
export function v1Routes(routes: RouteRegistry, deps: V1Deps) {
  const { db, appUrl } = deps;
  const m = contracts.v1Meta;
  const r = contracts.v1Records;
  const cm = contracts.v1Comments;

  routes.use('/api/v1/*', v1Errors);
  // Webhooks and automations first: `/api/v1/:baseId/:tableIdOrName/:recordId` would match their list.
  webhookRoutes(routes, deps.webhooks);
  v1AutomationRoutes(routes, deps.automations);
  // Rate limits per base and per token or user: `apiAdmission` in requireSession.

  // Resource routes on the base in the path, needing the token scope of what they do.
  const base = (token: TokenScope) => ({ resource: 'base', action: 'base:read', token }) as const;

  // Listed before `/api/v1/:baseId/:tableIdOrName`, which its path would match too.
  routes.endpoint(m.bases, 'session', (c) => listV1Bases(db, c.var.principal), {
    token: 'schema.bases:read',
  });

  routes.endpoint(m.tables, { resource: 'base', action: 'base:read' }, async (c) => ({
    tables: await v1Tables(c.var.tx, c.var.resource.id, c.var.principal.user.id),
  }));

  routes.endpoint(
    m.createTable,
    { resource: 'base', action: 'table:create' },
    async (c, { body }) => {
      const { tx, resource, principal } = c.var;
      const [row] = await tx.select().from(bases).where(eq(bases.id, resource.id));
      if (!row) throw new Error('authorized base not visible under RLS');
      const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
      const [first, ...rest] = body.fields.map((f, i) => fieldInput(f, `fields.${i}`));
      if (!first) throw new Error('createTable: no fields');
      const created = await createTable(ctx, row, {
        name: body.name,
        ...(body.description ? { description: body.description } : {}),
        primaryFieldName: first.name,
      });
      const table = await loadTable(tx, created.id);
      // The first field is the primary field: give it the type asked for.
      const primary = created.fields.find((f) => f.isPrimary);
      if (primary && (primary.type !== first.type || first.options || first.description)) {
        await updateField({ ...ctx, role: resource.role }, await loadField(tx, primary.id), {
          type: first.type,
          ...(first.options ? { options: first.options } : {}),
          ...(first.description ? { description: first.description } : {}),
        });
      }
      for (const field of rest) await createField(ctx, table, field);
      const [out] = await v1Tables(tx, resource.id, principal.user.id, table);
      if (!out) throw new Error('createTable: table missing');
      return out;
    }
  );

  routes.endpoint(m.createField, base('schema.bases:write'), async (c, { params, body }) => {
    const { tx, resource, principal } = c.var;
    const { table } = await authorizeTable(c, params.tableIdOrName, 'field:create');
    const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id };
    return toV1Field(await createField(ctx, table, fieldInput(body, 'type')));
  });

  routes.endpoint(m.updateField, base('schema.bases:write'), async (c, { params, body }) => {
    const { tx, resource, principal } = c.var;
    const { table } = await authorizeTable(c, params.tableIdOrName, 'table:read');
    const resolved = await resolveResource(tx, 'field', params.fieldId, principal.user.id);
    const role = assertAllowed(authorize(principal, 'field:update', resolved));
    const field = await loadField(tx, params.fieldId);
    if (field.tableId !== table.id) throw new AppError('NOT_FOUND', { detail: 'No such field.' });
    const ctx = { tx, workspaceId: resource.workspaceId, userId: principal.user.id, role };
    return toV1Field(await updateField(ctx, field, body));
  });

  // ---- records ----

  routes.endpoint(r.list, base('data.records:read'), async (c, { params, query }) => {
    const { table } = await authorizeTable(c, params.tableIdOrName, 'record:read');
    return listV1Records(c, table, query, appUrl);
  });

  routes.endpoint(r.listPost, base('data.records:read'), async (c, { params, body }) => {
    const { table } = await authorizeTable(c, params.tableIdOrName, 'record:read');
    return listV1Records(c, table, body, appUrl);
  });

  routes.endpoint(r.get, base('data.records:read'), async (c, { params, query }) => {
    const { table } = await authorizeTable(c, params.tableIdOrName, 'record:read');
    return getV1Record(c, table, params.recordId, query, appUrl);
  });

  routes.endpoint(r.create, base('data.records:write'), async (c, { params, body }) => {
    const { table, role } = await authorizeTable(c, params.tableIdOrName, 'record:create');
    const keys = await FieldKeys.of(c.var.tx, table);
    const ctx = await writeContext(c, table, role, body.typecast);
    const opts = { returnFieldsByFieldId: body.returnFieldsByFieldId };
    const many = 'records' in body;
    const writes = writesOf(keys, many ? body.records : [{ fields: body.fields }]);
    const created = await createRecords(
      ctx,
      writes.map((w) => w.fields)
    );
    // Fields read again: typecast may have added options.
    const records = await present(c, await FieldKeys.of(c.var.tx, table), created, opts, appUrl);
    if (many) return { records };
    const [one] = records;
    if (!one) throw new Error('create: no record');
    return one;
  });

  for (const [contract, destructive] of [
    [r.updateMany, false],
    [r.replaceMany, true],
  ] as const) {
    routes.endpoint(contract, base('data.records:write'), async (c, { params, body }) => {
      const { table, role } = await authorizeTable(c, params.tableIdOrName, 'record:update');
      const keys = await FieldKeys.of(c.var.tx, table);
      const ctx = await writeContext(c, table, role, body.typecast);
      const result = await updateV1Records(c, ctx, keys, writesOf(keys, body.records), {
        destructive,
        mergeOn: body.performUpsert?.fieldsToMergeOn,
      });
      const opts = { returnFieldsByFieldId: body.returnFieldsByFieldId };
      return {
        records: await present(
          c,
          await FieldKeys.of(c.var.tx, table),
          result.records,
          opts,
          appUrl
        ),
        ...(body.performUpsert
          ? { createdRecords: result.createdRecords, updatedRecords: result.updatedRecords }
          : {}),
      };
    });
  }

  for (const [contract, destructive] of [
    [r.update, false],
    [r.replace, true],
  ] as const) {
    routes.endpoint(contract, base('data.records:write'), async (c, { params, body }) => {
      const { table, role } = await authorizeTable(c, params.tableIdOrName, 'record:update');
      const keys = await FieldKeys.of(c.var.tx, table);
      const ctx = await writeContext(c, table, role, body.typecast);
      const writes = writesOf(keys, [{ id: params.recordId, fields: body.fields }]);
      const result = await updateV1Records(c, ctx, keys, writes, { destructive });
      const opts = { returnFieldsByFieldId: body.returnFieldsByFieldId };
      const [one] = await present(
        c,
        await FieldKeys.of(c.var.tx, table),
        result.records,
        opts,
        appUrl
      );
      if (!one) throw new Error('update: no record');
      return one;
    });
  }

  routes.endpoint(r.deleteMany, base('data.records:write'), async (c, { params, query }) => {
    const { table, role } = await authorizeTable(c, params.tableIdOrName, 'record:delete');
    const done = await deleteRecords(await writeContext(c, table, role, false), query.records);
    return { records: done };
  });

  routes.endpoint(r.delete, base('data.records:write'), async (c, { params }) => {
    const { table, role } = await authorizeTable(c, params.tableIdOrName, 'record:delete');
    const [done] = await deleteRecords(await writeContext(c, table, role, false), [
      params.recordId,
    ]);
    if (!done) throw new Error('delete: no record');
    return done;
  });

  // ---- comments ----

  const commentContext = async (
    c: Context<V1Env>,
    tableIdOrName: string,
    action: 'comment:read' | 'comment:create'
  ): Promise<CommentContext> => {
    const { table, role } = await authorizeTable(c, tableIdOrName, action);
    const { tx, resource, principal } = c.var;
    return { tx, workspaceId: resource.workspaceId, userId: principal.user.id, role, table };
  };

  /** A comment in Airtable's shape; `text` is the stored Markdown with mention tokens. */
  const toV1Comment = (
    comment: {
      id: string;
      authorId: string | null;
      body: string;
      createdAt: string;
      editedAt: string | null;
    },
    person: (id: string) => { id: string; email?: string; name?: string }
  ) => ({
    id: comment.id,
    author: comment.authorId ? person(comment.authorId) : { id: '' },
    text: comment.body,
    createdTime: comment.createdAt,
    lastUpdatedTime: comment.editedAt,
  });

  routes.endpoint(cm.list, base('data.recordComments:read'), async (c, { params, query }) => {
    const ctx = await commentContext(c, params.tableIdOrName, 'comment:read');
    // Newest first, as Airtable lists them; `offset` is the position of the next page.
    const all = (
      await listComments(ctx, params.recordId, { limit: MAX_COMMENTS_PER_RECORD })
    ).comments.reverse();
    const start = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The offset is invalid.',
        extensions: { errors: [{ path: 'offset', message: 'Not an offset of this list.' }] },
      });
    }
    const end = start + (query.pageSize ?? 100);
    const page = all.slice(start, end);
    const person = await collaborators(
      c,
      page.flatMap((x) => (x.authorId ? [x.authorId] : []))
    );
    return {
      comments: page.map((x) => toV1Comment(x, person)),
      offset: end < all.length ? String(end) : null,
    };
  });

  routes.endpoint(cm.create, base('data.recordComments:write'), async (c, { params, body }) => {
    const ctx = await commentContext(c, params.tableIdOrName, 'comment:create');
    const comment = await createComment(ctx, params.recordId, { body: body.text });
    const person = await collaborators(c, comment.authorId ? [comment.authorId] : []);
    return toV1Comment(comment, person);
  });
}
