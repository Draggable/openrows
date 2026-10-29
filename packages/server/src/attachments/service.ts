import {
  ATTACHMENT_DOWNLOAD_TTL_SECONDS,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  type AttachmentValue,
  type createAttachmentSchema,
  isInlineImageType,
  type ProblemFieldError,
} from '@openrows/shared';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { attachments, fields, type Transaction, views } from '../db/index.js';
import type { Entitlements } from '../edition/types.js';
import type { TableRow } from '../fields/service.js';
import type { Jobs } from '../jobs/send.js';
import { AppError } from '../lib/errors.js';
import { assertAttachmentRoom } from '../usage/quota.js';
import { visibleTo } from '../views/visibility.js';
import { type ObjectStore, UnknownObjectSizeError } from './storage.js';

/**
 * Attachments. The legacy uploads let a user confirm another tenant's key (H5), served
 * user files inline (M1, stored XSS through HTML or SVG) and ignored base roles (M7). Here:
 *
 * - the server picks the key, `ws/<workspace>/b/<base>/t/<table>/<attachment id>`, and the
 *   client only ever names an attachment id, which RLS and the table/base checks scope;
 * - the presigned PUT is signed for the announced Content-Type and Content-Length, and the
 *   confirmation checks the stored object's size again before the file becomes usable;
 * - downloads are short-lived signed URLs, `inline` only for raster images and `attachment`
 *   for everything else (SVG and HTML included);
 * - every route is authorized on the table in the path, so base-level roles apply.
 */

export type AttachmentRow = typeof attachments.$inferSelect;

export interface AttachmentScope {
  tx: Transaction;
  workspaceId: string;
  userId: string;
  table: TableRow;
}

export function storageKey(row: Pick<AttachmentRow, 'workspaceId' | 'baseId' | 'tableId' | 'id'>) {
  return `ws/${row.workspaceId}/b/${row.baseId}/t/${row.tableId}/${row.id}`;
}

export const thumbnailKeyOf = (key: string) => `${key}.thumb.webp`;

/** The cell value of a stored file: the server's metadata, never the client's. */
export function toValue(row: AttachmentRow): AttachmentValue {
  return {
    id: row.id,
    filename: row.filename,
    size: row.size,
    type: row.contentType,
    ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
  };
}

function needStore(store: ObjectStore | undefined): ObjectStore {
  if (!store) {
    throw new AppError('SERVICE_UNAVAILABLE', { detail: "File storage isn't configured." });
  }
  return store;
}

function invalid(errors: ProblemFieldError[], detail: string): never {
  throw new AppError('VALIDATION_FAILED', { detail, extensions: { errors } });
}

/**
 * The attachment field of the table a file is announced for, or the form view of the
 * table whose cover or logo it is: a live form view the user can see (another user's personal
 * view is no such view).
 */
async function uploadOwner(
  s: AttachmentScope,
  input: ReturnType<typeof createAttachmentSchema.parse>
): Promise<{ fieldId: string; viewId: null } | { fieldId: null; viewId: string }> {
  if (input.viewId !== undefined) {
    const [view] = await s.tx
      .select({ id: views.id, type: views.type })
      .from(views)
      .where(
        and(
          eq(views.id, input.viewId),
          eq(views.tableId, s.table.id),
          isNull(views.deletedAt),
          visibleTo(s.userId)
        )
      );
    if (!view) invalid([{ path: 'viewId', message: 'No such view in this table.' }], 'No view.');
    if (view.type !== 'form') {
      invalid([{ path: 'viewId', message: 'Not a form view.' }], 'Not a form view.');
    }
    return { fieldId: null, viewId: view.id };
  }
  const [field] = await s.tx
    .select({ id: fields.id, type: fields.type })
    .from(fields)
    .where(
      and(
        eq(fields.id, input.fieldId ?? ''),
        eq(fields.tableId, s.table.id),
        isNull(fields.deletedAt)
      )
    );
  if (!field) invalid([{ path: 'fieldId', message: 'No such field in this table.' }], 'No field.');
  if (field.type !== 'attachment') {
    invalid([{ path: 'fieldId', message: 'Not an attachment field.' }], 'Not an attachment field.');
  }
  return { fieldId: field.id, viewId: null };
}

/**
 * Records a pending file for an attachment field of the table (or a form view's image)
 * and presigns its upload.
 */
export async function createUpload(
  s: AttachmentScope,
  storeOrNone: ObjectStore | undefined,
  input: ReturnType<typeof createAttachmentSchema.parse>,
  entitlements: Entitlements
) {
  const store = needStore(storeOrNone);
  const owner = await uploadOwner(s, input);
  // The plan's attachment storage: no new file past it; existing ones stay readable.
  await assertAttachmentRoom(s.tx, entitlements, s.workspaceId, input.size);
  const id = uuidv7();
  const key = storageKey({
    id,
    workspaceId: s.workspaceId,
    baseId: s.table.baseId,
    tableId: s.table.id,
  });
  const contentType = input.type || 'application/octet-stream';
  const [row] = await s.tx
    .insert(attachments)
    .values({
      id,
      workspaceId: s.workspaceId,
      baseId: s.table.baseId,
      tableId: s.table.id,
      ...owner,
      storageKey: key,
      filename: input.filename,
      contentType,
      size: input.size,
      createdBy: s.userId,
    })
    .returning();
  if (!row) throw new Error('attachment insert returned no row');
  const upload = await store.presignPut(key, {
    contentType,
    size: input.size,
    expiresIn: ATTACHMENT_UPLOAD_TTL_SECONDS,
  });
  return {
    attachment: toValue(row),
    upload: {
      method: 'PUT' as const,
      ...upload,
      expiresAt: new Date(Date.now() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    },
  };
}

/** The file of this table (pending or ready), locked, or 404. */
async function lockOwn(s: AttachmentScope, id: string) {
  const [row] = await s.tx
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.tableId, s.table.id)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such attachment in this table.' });
  return row;
}

/** The queue of malware scans; its job data is `{ workspaceId, attachmentId }`. */
export const SCAN_QUEUE = 'attachments.scan';

/**
 * Malware scanning of confirmed uploads: with it, a confirmed upload is `scanning` and its
 * scan job is sent in the confirming transaction; the worker then marks it `ready` or
 * `infected`. Without it (no CLAMAV_URL), uploads are ready when confirmed.
 */
export interface UploadScanning {
  jobs: Jobs;
}

/** Sends the scan job of a `scanning` file, in `tx` (one per file: its id is the singleton). */
export async function sendScan(
  tx: Transaction,
  jobs: Jobs,
  row: Pick<AttachmentRow, 'id' | 'workspaceId'>
): Promise<void> {
  await jobs.send(
    tx,
    SCAN_QUEUE,
    { workspaceId: row.workspaceId, attachmentId: row.id },
    { singletonKey: row.id }
  );
}

/**
 * Marks an upload ready (or, with `scanning`, waiting for its malware scan) once the
 * object under the server's key exists with the announced size (a mismatch deletes the object
 * and is a 422). A store that doesn't report the size is a 503 that keeps the object and the
 * pending row, so the confirm can be retried. Idempotent for a confirmed file.
 */
export async function confirmUpload(
  s: AttachmentScope,
  storeOrNone: ObjectStore | undefined,
  id: string,
  scanning?: UploadScanning
): Promise<{ row: AttachmentRow; confirmed: boolean }> {
  const store = needStore(storeOrNone);
  const row = await lockOwn(s, id);
  if (row.status === 'infected') throw quarantined();
  if (row.status !== 'pending') return { row, confirmed: false };
  const head = await store.head(row.storageKey).catch((err: unknown) => {
    if (!(err instanceof UnknownObjectSizeError)) throw err;
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail: "File storage didn't report the uploaded file's size. Try again later.",
      cause: err,
    });
  });
  if (!head) {
    throw new AppError('CONFLICT', { detail: "The file hasn't been uploaded yet." });
  }
  if (head.size !== row.size) {
    // The row stays pending (the 422 rolls the transaction back); the object goes.
    await store.delete(row.storageKey);
    throw new AppError('VALIDATION_FAILED', {
      detail: `The uploaded file has ${head.size} bytes, not the ${row.size} announced.`,
      extensions: { errors: [{ path: 'size', message: 'Size mismatch.' }] },
    });
  }
  const [ready] = await s.tx
    .update(attachments)
    .set({ status: scanning ? 'scanning' : 'ready', confirmedAt: new Date() })
    .where(eq(attachments.id, row.id))
    .returning();
  if (!ready) throw new Error('attachment update returned no row');
  if (scanning) await sendScan(s.tx, scanning.jobs, ready);
  return { row: ready, confirmed: true };
}

/** A file the scanner found malware in: never usable, never served. */
export function quarantined(): AppError {
  return new AppError('ATTACHMENT_QUARANTINED', {
    detail: 'This file contains malware and was quarantined. It can’t be used or downloaded.',
  });
}

/** Files a cell may name: ready ones, and ones still being scanned. */
export const USABLE_STATUSES = ['ready', 'scanning'] as const;

/**
 * The canonical values of attachment cells about to be written: every id must be a ready (or
 * , still scanning) file of this table's base (else an error at the cell's path), and the stored metadata replaces
 * whatever the client sent. A public form's upload is only usable by its form's
 * submission (`form`) until it is submitted, and a submission takes nothing else.
 */
export async function canonicalAttachments(
  tx: Transaction,
  table: TableRow,
  cells: { path: string; value: AttachmentValue[] }[],
  errors: ProblemFieldError[],
  form?: { shareId: string }
): Promise<AttachmentValue[][]> {
  const ids = [...new Set(cells.flatMap((c) => c.value.map((a) => a.id)))];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const valid = ids.filter((i) => uuid.test(i));
  const rows = valid.length
    ? await tx
        .select()
        .from(attachments)
        .where(
          and(
            inArray(attachments.id, valid),
            eq(attachments.baseId, table.baseId),
            inArray(attachments.status, [...USABLE_STATUSES]),
            // A form's cover or logo isn't a cell's file.
            isNotNull(attachments.fieldId),
            form
              ? and(eq(attachments.shareId, form.shareId), isNull(attachments.recordId))
              : or(isNull(attachments.shareId), isNotNull(attachments.recordId))
          )
        )
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return cells.map((cell) =>
    cell.value.flatMap((a) => {
      const row = byId.get(a.id);
      if (!row) {
        errors.push({ path: cell.path, message: `No uploaded file ${a.id} in this base.` });
        return [];
      }
      return [toValue(row)];
    })
  );
}

/** RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name. */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * A signed URL of a ready file of the table's base: `inline` only for raster images,
 * `attachment` for everything else. With `thumbnail`, the thumbnail (or, while the job hasn't
 * made it, the image itself); a file without one is a 404. A file still being scanned is
 * a 409 ATTACHMENT_SCANNING, an infected one a 403 ATTACHMENT_QUARANTINED: neither is served.
 */
export async function signedDownload(
  s: Omit<AttachmentScope, 'userId'>,
  storeOrNone: ObjectStore | undefined,
  id: string,
  thumbnail: boolean
): Promise<string> {
  const store = needStore(storeOrNone);
  const [row] = await s.tx
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.id, id),
        eq(attachments.baseId, s.table.baseId),
        inArray(attachments.status, ['ready', 'scanning', 'infected'])
      )
    );
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such attachment.' });
  if (row.status === 'infected') throw quarantined();
  if (row.status === 'scanning') {
    throw new AppError('ATTACHMENT_SCANNING', {
      detail: 'This file is being checked for malware. Try again in a moment.',
    });
  }
  const image = isInlineImageType(row.contentType);
  if (thumbnail && !row.thumbnailKey && !image) {
    throw new AppError('NOT_FOUND', { detail: 'This file has no thumbnail.' });
  }
  const useThumb = thumbnail && row.thumbnailKey !== null;
  return store.presignGet(useThumb && row.thumbnailKey ? row.thumbnailKey : row.storageKey, {
    contentType: useThumb ? 'image/webp' : row.contentType,
    disposition: contentDisposition(
      useThumb || image ? 'inline' : 'attachment',
      useThumb ? `${row.filename}.webp` : row.filename
    ),
    expiresIn: ATTACHMENT_DOWNLOAD_TTL_SECONDS,
  });
}

/** Confirmed files and their thumbnails in the workspace in scope (RLS). */
export async function storageUsage(tx: Transaction, workspaceId: string) {
  const [row] = await tx
    .select({
      files: sql<string>`count(*)`,
      bytes: sql<string>`coalesce(sum(${attachments.size} + coalesce(${attachments.thumbnailSize}, 0)), 0)`,
    })
    .from(attachments)
    .where(and(eq(attachments.workspaceId, workspaceId), eq(attachments.status, 'ready')));
  return { workspaceId, files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}
