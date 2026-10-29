import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { inScope } from '../authz/scope.js';
import { attachments, type Database } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import { thumbnailKeyOf } from './service.js';
import type { ObjectStore } from './storage.js';

/** The longest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 512;
/** Images larger than this aren't thumbnailed (the grid shows an icon). */
export const MAX_THUMBNAIL_INPUT_BYTES = 40 * 1024 * 1024;
/** Decompression-bomb guard: at most this many input pixels. */
const MAX_INPUT_PIXELS = 100_000_000;
/** What sharp must detect from the bytes (not the declared type): never SVG or PDF. */
const RASTER_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);
const CONCURRENCY = 2;

export interface ThumbnailTask {
  workspaceId: string;
  userId: string;
  attachmentId: string;
}

/** A WebP thumbnail of a raster image and the image's oriented size; null for anything else. */
export async function makeThumbnail(
  input: Uint8Array
): Promise<{ thumbnail: Buffer; width: number; height: number } | null> {
  const image = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false });
  const meta = await image.metadata();
  if (!meta.format || !RASTER_FORMATS.has(meta.format) || !meta.width || !meta.height) return null;
  const swap = (meta.orientation ?? 1) >= 5;
  const thumbnail = await image
    .rotate()
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  return {
    thumbnail,
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height,
  };
}

/**
 * Image thumbnails, made in the background after an upload is confirmed. In-process with
 * a small concurrency until the M4 worker takes the job over (ADR-004); a restart loses queued
 * thumbnails, and the grid shows the image itself instead.
 */
export class ThumbnailJobs {
  readonly #queue: ThumbnailTask[] = [];
  readonly #idle = new Set<() => void>();
  #running = 0;

  constructor(
    private readonly db: Database,
    private readonly store: ObjectStore | undefined,
    private readonly logger: Logger
  ) {}

  enqueue(task: ThumbnailTask): void {
    if (!this.store) return;
    this.#queue.push(task);
    this.#pump();
  }

  /** Resolves once the queue is empty and nothing runs (tests). */
  idle(): Promise<void> {
    if (this.#running === 0 && this.#queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.add(resolve));
  }

  #pump() {
    while (this.#running < CONCURRENCY) {
      const task = this.#queue.shift();
      if (!task) break;
      this.#running++;
      this.#run(task)
        .catch((err) =>
          this.logger.warn({ err, attachmentId: task.attachmentId }, 'thumbnail failed')
        )
        .finally(() => {
          this.#running--;
          this.#pump();
          if (this.#running === 0 && this.#queue.length === 0) {
            for (const resolve of this.#idle) resolve();
            this.#idle.clear();
          }
        });
    }
  }

  async #run(task: ThumbnailTask) {
    if (this.store) await thumbnailAttachment(this.db, this.store, task);
  }
}

/**
 * Makes the thumbnail of one ready raster image and records it with the image's size; anything
 * else (not ready, already done, too large, not a raster image) is left alone. Also run by the
 * worker after a clean malware scan.
 */
export async function thumbnailAttachment(
  db: Database,
  store: ObjectStore,
  task: ThumbnailTask
): Promise<void> {
  const scope = { workspaceId: task.workspaceId, userId: task.userId };
  // Enqueued before the confirming transaction commits: FOR UPDATE waits for it, then reads
  // the committed row (still pending if it rolled back).
  const [row] = await inScope(db, scope, (tx) =>
    tx.select().from(attachments).where(eq(attachments.id, task.attachmentId)).for('update')
  );
  if (row?.status !== 'ready' || row.thumbnailKey) return;
  if (row.size > MAX_THUMBNAIL_INPUT_BYTES) return;
  const made = await makeThumbnail(await store.get(row.storageKey, MAX_THUMBNAIL_INPUT_BYTES));
  if (!made) return;
  const key = thumbnailKeyOf(row.storageKey);
  await store.put(key, made.thumbnail, 'image/webp');
  await inScope(db, scope, (tx) =>
    tx
      .update(attachments)
      .set({
        thumbnailKey: key,
        thumbnailSize: made.thumbnail.byteLength,
        width: made.width,
        height: made.height,
      })
      .where(eq(attachments.id, row.id))
  );
}
