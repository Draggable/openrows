import {
  csvLine,
  type FieldTypeDef,
  getFieldType,
  gridLayoutOf,
  neutralizeCell,
  QUERY_PAGE_MAX,
  type ViewQuery,
} from '@openrows/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { inScope } from '../authz/scope.js';
import { type Database, type Transaction, views } from '../db/index.js';
import { type FieldRow, fieldType, liveFields, type TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { queryRecords } from '../records/service.js';
import { visibleTo } from '../views/visibility.js';
import { collaboratorNames, type DirectoryAccess } from '../workspaces/collaborators.js';

/**
 * Streaming CSV export of a view: the view's filter and sorts (and groups, as order) with
 * the caller's unsaved changes on top, its visible fields in its column order, and one keyset
 * page of 1,000 records at a time, each page in its own read transaction, so a table of any
 * size streams in constant memory. Cells are display text (`format`, as Airtable exports), and
 * every cell is guarded against formula injection (`neutralizeCell`).
 */

/** The fields a view shows, in its column order: primary first, hidden ones left out. */
export function viewFields(live: readonly FieldRow[], config: unknown): FieldRow[] {
  const layout = gridLayoutOf((config ?? {}) as Record<string, unknown>);
  const hidden = new Set(layout.hiddenFields ?? []);
  const byId = new Map(live.map((f) => [f.id, f]));
  const out = live.filter((f) => f.isPrimary);
  const seen = new Set(out.map((f) => f.id));
  for (const id of [...(layout.fieldOrder ?? []), ...live.map((f) => f.id)]) {
    const f = byId.get(id);
    if (f && !seen.has(id) && !hidden.has(id)) {
      seen.add(id);
      out.push(f);
    }
  }
  return out;
}

export interface CsvExport {
  filename: string;
  stream: ReadableStream<Uint8Array>;
}

/** A file name without path or control characters. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim();
  return cleaned.slice(0, 150) || 'export';
}

/**
 * Checks the export in the request's transaction (the view is this table's, the query compiles:
 * 404 / 422 before any byte is sent), then answers the stream.
 */
export async function exportCsv(
  db: Database,
  tx: Transaction,
  scope: { workspaceId: string; userId: string },
  table: TableRow,
  input: { viewId?: string; query?: ViewQuery },
  logger: Logger,
  directory: DirectoryAccess = {
    workspaceId: scope.workspaceId,
    bases: [table.baseId],
    emails: false,
  }
): Promise<CsvExport> {
  const live = await liveFields(tx, table.id);
  let viewName: string | undefined;
  let fields: FieldRow[] = live;
  if (input.viewId) {
    const [view] = await tx
      .select({ name: views.name, config: views.config })
      .from(views)
      .where(
        and(
          eq(views.id, input.viewId),
          eq(views.tableId, table.id),
          isNull(views.deletedAt),
          visibleTo(scope.userId)
        )
      );
    if (!view) throw new AppError('NOT_FOUND', { detail: 'No such view in this table.' });
    viewName = view.name;
    fields = viewFields(live, view.config);
  }
  if (input.query?.fields) {
    const byId = new Map(live.map((f) => [f.id, f]));
    fields = input.query.fields.flatMap((id) => byId.get(id) ?? []);
  }
  const query = { ...input.query, fields: fields.map((f) => f.id) };
  const ctx = (t: Transaction) => ({ tx: t, ...scope, table });
  // Validates the view and the query (422 for a bad one) before streaming.
  let first = await queryRecords(ctx(tx), {
    viewId: input.viewId,
    query,
    limit: QUERY_PAGE_MAX,
    count: false,
    groups: false,
  });

  // User cells as display names from the caller's collaborator directory.
  const names = await collaboratorNames(tx, directory);
  const format = { userName: (id: string) => names.get(id) };
  const columns = fields.map((f) => {
    const def: FieldTypeDef = getFieldType(fieldType(f));
    return { id: f.id, def, options: def.optionsSchema.parse(f.config ?? {}) };
  });
  const encoder = new TextEncoder();
  let header = true;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let text = '';
        if (header) {
          header = false;
          // A BOM, so Excel reads the file as UTF-8.
          text += `﻿${csvLine(fields.map((f) => neutralizeCell(f.name)))}`;
        }
        for (const record of first.records) {
          text += csvLine(
            columns.map((c) =>
              neutralizeCell(c.def.format(record.fields[c.id] ?? null, c.options, format))
            )
          );
        }
        controller.enqueue(encoder.encode(text));
        const cursor = first.nextCursor;
        if (!cursor || cancelled) {
          controller.close();
          return;
        }
        first = await inScope(db, scope, (t) =>
          queryRecords(ctx(t), {
            viewId: input.viewId,
            query,
            limit: QUERY_PAGE_MAX,
            cursor,
            count: false,
            groups: false,
          })
        );
      } catch (err) {
        logger.error({ err, tableId: table.id }, 'CSV export failed');
        controller.error(err);
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    filename: `${safeFileName(viewName ? `${table.name} - ${viewName}` : table.name)}.csv`,
    stream,
  };
}
