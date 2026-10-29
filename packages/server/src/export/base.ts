import {
  csvLine,
  getFieldType,
  neutralizeCell,
  QUERY_PAGE_MAX,
  type RecordData,
} from '@openrows/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { ObjectStore } from '../attachments/storage.js';
import { inScope } from '../authz/scope.js';
import { attachments, bases, type Database, type Transaction, tables, views } from '../db/index.js';
import { type FieldRow, fieldType, liveFields, type TableRow, toField } from '../fields/service.js';
import { safeFileName } from '../import-export/export.js';
import { AppError } from '../lib/errors.js';
import { queryRecords } from '../records/service.js';
import { visibleTo } from '../views/visibility.js';
import { collaboratorNames, type DirectoryAccess } from '../workspaces/collaborators.js';
import type { ZipEntry } from './zip.js';

/**
 * Whole-base export: everything the caller can read of a live base, as ZIP entries under
 * `prefix`:
 *
 * - `schema.json`: the base, its tables with their fields (types and options, as the API
 *   returns them), the views the caller can see, and where each table's files are;
 * - `tables/<n> <name>.csv`: every field of every record as display text (as the view export
 * , guarded against formula injection), importable with the CSV import;
 * - `records/<n> <name>.jsonl`: one record per line with its id and every value as the API
 *   returns it (link values carry the linked records' ids);
 * - `attachments.jsonl`: one line per file (id, table, field, name, type, size, and either its
 *   path in the archive or a signed URL), and the files under `attachments/<id>/<name>`.
 *
 * The schema is read in the request's transaction (a 404 before any byte is sent); records and
 * attachment rows are read one page at a time, each page in its own read transaction, so a base
 * of any size streams in bounded memory. The export is therefore not one point in time across
 * tables (a base snapshot, is).
 */

export const BASE_EXPORT_FORMAT = 'openrows.base-export';
export const BASE_EXPORT_VERSION = 1;
/** How long the signed URLs of `attachments=links` stay valid (SigV4's maximum is 7 days). */
export const EXPORT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
const ATTACHMENT_PAGE = 500;

export interface ExportScope {
  workspaceId: string;
  userId: string;
}

export interface BaseExportOptions {
  /** Files in the archive (`files`, when a store is configured) or signed URLs (`links`). */
  attachments: 'files' | 'links';
  directory: DirectoryAccess;
  /** Hears an attachment whose stored object couldn't be read (it is left out). */
  onMissingFile?: (attachmentId: string, err: unknown) => void;
}

/** A path segment from a user-given name: no separators, controls or dot-only names. */
export function entryName(name: string, fallback = 'file'): string {
  const cleaned = safeFileName(name).replace(/^\.+/, '').trim();
  return cleaned || fallback;
}

interface PlannedTable {
  row: TableRow;
  fields: FieldRow[];
  csv: string;
  records: string;
}

export interface BaseExportPlan {
  baseName: string;
  entries: (prefix: string) => AsyncGenerator<ZipEntry>;
}

/**
 * Reads the base's schema in `tx` (404 for a missing or trashed base) and answers the entries,
 * which read the records lazily as the archive is written.
 */
export async function planBaseExport(
  db: Database,
  tx: Transaction,
  scope: ExportScope,
  baseId: string,
  store: ObjectStore | undefined,
  opts: BaseExportOptions
): Promise<BaseExportPlan> {
  const [base] = await tx
    .select()
    .from(bases)
    .where(and(eq(bases.id, baseId), isNull(bases.deletedAt)));
  if (!base) throw new AppError('NOT_FOUND', { detail: 'No such base.' });
  const tableRows = await tx
    .select()
    .from(tables)
    .where(and(eq(tables.baseId, baseId), isNull(tables.deletedAt)))
    .orderBy(asc(tables.position), asc(tables.createdAt));
  const planned: PlannedTable[] = [];
  for (const [i, row] of tableRows.entries()) {
    const file = `${String(i + 1).padStart(2, '0')} ${entryName(row.name, 'Table')}`;
    planned.push({
      row,
      fields: await liveFields(tx, row.id),
      csv: `tables/${file}.csv`,
      records: `records/${file}.jsonl`,
    });
  }
  const viewRows = tableRows.length
    ? await tx
        .select()
        .from(views)
        .where(
          and(
            inArray(
              views.tableId,
              tableRows.map((t) => t.id)
            ),
            isNull(views.deletedAt),
            visibleTo(scope.userId)
          )
        )
        .orderBy(asc(views.position), asc(views.createdAt))
    : [];
  const names = await collaboratorNames(tx, opts.directory);
  const exportedAt = new Date();
  const withFiles = opts.attachments === 'files' && store !== undefined;

  const schema = {
    format: BASE_EXPORT_FORMAT,
    version: BASE_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    base: {
      id: base.id,
      name: base.name,
      description: base.description,
      icon: base.icon,
      color: base.color,
    },
    tables: planned.map((t) => ({
      id: t.row.id,
      name: t.row.name,
      description: t.row.description,
      icon: t.row.icon,
      csv: t.csv,
      records: t.records,
      fields: t.fields.map((f) => {
        const { deletedAt: _deleted, tableId: _table, ...field } = toField(f);
        return field;
      }),
      views: viewRows
        .filter((v) => v.tableId === t.row.id)
        .map((v) => ({
          id: v.id,
          name: v.name,
          type: v.type,
          personal: v.personal,
          config: v.config,
        })),
    })),
    attachments: {
      manifest: 'attachments.jsonl',
      files: withFiles ? 'attachments/<id>/<filename>' : null,
    },
  };

  const read = <T>(fn: (t: Transaction) => Promise<T>) => inScope(db, scope, fn);

  /** Every live record of the table, a keyset page at a time. */
  async function* records(table: PlannedTable): AsyncGenerator<RecordData[]> {
    const ctx = (t: Transaction) => ({ tx: t, ...scope, table: table.row });
    let cursor: string | undefined;
    do {
      const page = await read((t) =>
        queryRecords(ctx(t), {
          query: { fields: table.fields.map((f) => f.id) },
          limit: QUERY_PAGE_MAX,
          count: false,
          groups: false,
          ...(cursor ? { cursor } : {}),
        })
      );
      yield page.records;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  async function* csv(table: PlannedTable): AsyncGenerator<string> {
    const format = { userName: (id: string) => names.get(id) };
    const columns = table.fields.map((f) => {
      const def = getFieldType(fieldType(f));
      return { id: f.id, def, options: def.optionsSchema.parse(f.config ?? {}) };
    });
    yield `﻿${csvLine(table.fields.map((f) => neutralizeCell(f.name)))}`;
    for await (const page of records(table)) {
      let text = '';
      for (const r of page) {
        text += csvLine(
          columns.map((c) =>
            neutralizeCell(c.def.format(r.fields[c.id] ?? null, c.options, format))
          )
        );
      }
      yield text;
    }
  }

  async function* jsonl(table: PlannedTable): AsyncGenerator<string> {
    for await (const page of records(table)) {
      let text = '';
      for (const r of page) {
        text += `${JSON.stringify({
          id: r.id,
          createdAt: r.createdAt,
          createdBy: r.createdBy,
          updatedAt: r.updatedAt,
          updatedBy: r.updatedBy,
          fields: r.fields,
        })}\n`;
      }
      yield text;
    }
  }

  type AttachmentRow = typeof attachments.$inferSelect;
  const live = new Set(planned.map((t) => t.row.id));
  /** The base's confirmed files of live tables, a page at a time. */
  async function* attachmentPages(): AsyncGenerator<AttachmentRow[]> {
    let after: string | undefined;
    for (;;) {
      const page = await read((t) =>
        t
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.baseId, baseId),
              eq(attachments.status, 'ready'),
              // A form submitter's upload counts once it is in a record.
              or(isNull(attachments.shareId), isNotNull(attachments.recordId)),
              after ? gt(attachments.id, after) : undefined
            )
          )
          .orderBy(asc(attachments.id))
          .limit(ATTACHMENT_PAGE)
      );
      yield page.filter((a) => live.has(a.tableId));
      if (page.length < ATTACHMENT_PAGE) return;
      after = page.at(-1)?.id;
    }
  }
  const filePath = (a: AttachmentRow) => `attachments/${a.id}/${entryName(a.filename)}`;

  async function* manifest(): AsyncGenerator<string> {
    for await (const page of attachmentPages()) {
      let text = '';
      for (const a of page) {
        const line: Record<string, unknown> = {
          id: a.id,
          tableId: a.tableId,
          fieldId: a.fieldId,
          filename: a.filename,
          type: a.contentType,
          size: a.size,
          createdAt: a.createdAt.toISOString(),
        };
        if (withFiles) line['path'] = filePath(a);
        else if (store) {
          line['url'] = await store.presignGet(a.storageKey, {
            contentType: a.contentType,
            disposition: `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
            expiresIn: EXPORT_LINK_TTL_SECONDS,
          });
          line['urlExpiresAt'] = new Date(
            Date.now() + EXPORT_LINK_TTL_SECONDS * 1000
          ).toISOString();
        }
        text += `${JSON.stringify(line)}\n`;
      }
      yield text;
    }
  }

  async function* entries(prefix: string): AsyncGenerator<ZipEntry> {
    const modified = exportedAt;
    yield {
      name: `${prefix}schema.json`,
      data: [`${JSON.stringify(schema, null, 2)}\n`],
      modified,
    };
    for (const table of planned) {
      yield { name: `${prefix}${table.csv}`, data: csv(table), modified };
      yield { name: `${prefix}${table.records}`, data: jsonl(table), modified };
    }
    yield { name: `${prefix}attachments.jsonl`, data: manifest(), modified };
    if (withFiles && store) {
      for await (const page of attachmentPages()) {
        for (const a of page) {
          // Opened before its entry starts: a file gone from storage becomes a note in its
          // place rather than failing the whole archive halfway.
          const body = await store.getStream(a.storageKey).catch((err: unknown) => {
            opts.onMissingFile?.(a.id, err);
            return null;
          });
          yield body
            ? { name: `${prefix}${filePath(a)}`, data: body, store: true, modified: a.createdAt }
            : {
                name: `${prefix}${filePath(a)}.unavailable.txt`,
                data: [`The file "${a.filename}" (${a.id}) couldn't be read from storage.\n`],
                modified,
              };
        }
      }
    }
  }

  return { baseName: base.name, entries };
}
