import {
  type AttachmentValue,
  isInlineImageType,
  MAX_AIRTABLE_ATTACHMENT_BYTES,
} from '@openrows/shared';
import { uuidv7 } from 'uuidv7';
import { storageKey, thumbnailKeyOf } from '../attachments/service.js';
import type { ObjectStore } from '../attachments/storage.js';
import { MAX_THUMBNAIL_INPUT_BYTES, makeThumbnail } from '../attachments/thumbnails.js';
import { attachments, type Transaction } from '../db/index.js';
import { type AirtableClient, AttachmentError } from './client.js';

/**
 * Attachments of an Airtable import. Airtable's cells name files on its CDN by signed
 * URLs that expire within hours, so each page's files are copied while the page is imported:
 * downloaded from Airtable's file hosts only (the client checks), a few at a time, then stored
 * under our own key like an upload. The bytes decide the type of an image (a "PNG" that
 * isn't one is stored as a download), raster images get their thumbnail, and the rows are
 * inserted as ready files of the field in the page's transaction. A file that fails is listed in
 * the report; the cell keeps the others.
 */

/** Downloads of a page running at once. */
export const ATTACHMENT_CONCURRENCY = 4;
/** Most files one cell takes from Airtable. */
export const MAX_FILES_PER_CELL = 100;

/** One file of an Airtable attachment cell (`{ id, url, filename, size, type }`). */
export interface AirtableFile {
  url: string;
  filename: string;
  size?: number;
  type?: string;
}

export function airtableFiles(value: unknown): AirtableFile[] {
  if (!Array.isArray(value)) return [];
  const out: AirtableFile[] = [];
  for (const raw of value.slice(0, MAX_FILES_PER_CELL)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o['url'] !== 'string') continue;
    out.push({
      url: o['url'],
      filename: cleanFilename(o['filename']),
      ...(typeof o['size'] === 'number' ? { size: o['size'] } : {}),
      ...(typeof o['type'] === 'string' ? { type: o['type'] } : {}),
    });
  }
  return out;
}

/** A file name without control characters or path separators, 1 to 255 characters. */
export function cleanFilename(raw: unknown): string {
  const name =
    typeof raw === 'string'
      ? raw
          // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
          .replace(/[\u0000-\u001f\u007f/\\]/g, '')
          .trim()
          .slice(0, 255)
      : '';
  return name || 'file';
}

const RASTER_MAGIC: [string, (b: Uint8Array) => boolean][] = [
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38],
  [
    'image/webp',
    (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  ],
];

/**
 * The type a copied file is stored with: a raster image by its bytes, whatever was declared;
 * a declared image type the bytes don't back becomes a plain download; else the declared type
 * when it is a well-formed MIME type.
 */
export function sniffType(body: Uint8Array, declared: string | undefined): string {
  for (const [type, test] of RASTER_MAGIC) if (test(body)) return type;
  const clean = (declared ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(clean) || clean.length > 255) return 'application/octet-stream';
  // A raster type the bytes don't back; SVG and the rest keep theirs (they download, never inline).
  return isInlineImageType(clean) ? 'application/octet-stream' : clean;
}

/** A copied file, stored, waiting for its row in the page's transaction. */
export interface StoredFile {
  id: string;
  storageKey: string;
  filename: string;
  contentType: string;
  size: number;
  width?: number;
  height?: number;
  thumbnailKey?: string;
  thumbnailSize?: number;
}

export interface FileTarget {
  workspaceId: string;
  baseId: string;
  tableId: string;
}

/** Runs `fn` over `items`, `limit` at a time, in order of the results. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Downloads one file and stores it (and its thumbnail); the reason it couldn't otherwise. */
export async function copyFile(
  airtable: Pick<AirtableClient, 'download'>,
  store: ObjectStore | undefined,
  target: FileTarget,
  file: AirtableFile
): Promise<StoredFile | { error: string }> {
  if (!store) return { error: "File storage isn't configured here." };
  if (file.size !== undefined && file.size > MAX_AIRTABLE_ATTACHMENT_BYTES) {
    return {
      error: `The file is larger than ${MAX_AIRTABLE_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
    };
  }
  try {
    const { body, contentType: served } = await airtable.download(
      file.url,
      MAX_AIRTABLE_ATTACHMENT_BYTES
    );
    const id = uuidv7();
    const key = storageKey({ id, ...target });
    const contentType = sniffType(body, file.type ?? served);
    await store.put(key, body, contentType);
    const stored: StoredFile = {
      id,
      storageKey: key,
      filename: file.filename,
      contentType,
      size: body.byteLength,
    };
    if (isInlineImageType(contentType) && body.byteLength <= MAX_THUMBNAIL_INPUT_BYTES) {
      const made = await makeThumbnail(body).catch(() => null);
      if (made) {
        const thumbKey = thumbnailKeyOf(key);
        await store.put(thumbKey, made.thumbnail, 'image/webp');
        Object.assign(stored, {
          width: made.width,
          height: made.height,
          thumbnailKey: thumbKey,
          thumbnailSize: made.thumbnail.byteLength,
        });
      }
    }
    return stored;
  } catch (err) {
    if (err instanceof AttachmentError) return { error: err.message };
    throw err;
  }
}

/**
 * The rows of a page's copied files (in its transaction), ready or waiting for the
 * malware scan, and their cell values.
 */
export async function insertFiles(
  tx: Transaction,
  target: FileTarget & { fieldId: string; userId: string },
  files: StoredFile[],
  status: 'ready' | 'scanning' = 'ready'
): Promise<AttachmentValue[]> {
  if (!files.length) return [];
  await tx.insert(attachments).values(
    files.map((f) => ({
      id: f.id,
      workspaceId: target.workspaceId,
      baseId: target.baseId,
      tableId: target.tableId,
      fieldId: target.fieldId,
      storageKey: f.storageKey,
      filename: f.filename,
      contentType: f.contentType,
      size: f.size,
      status,
      width: f.width ?? null,
      height: f.height ?? null,
      thumbnailKey: f.thumbnailKey ?? null,
      thumbnailSize: f.thumbnailSize ?? null,
      createdBy: target.userId,
      confirmedAt: new Date(),
    }))
  );
  return files.map((f) => ({
    id: f.id,
    filename: f.filename,
    size: f.size,
    type: f.contentType,
    ...(f.width && f.height ? { width: f.width, height: f.height } : {}),
  }));
}
