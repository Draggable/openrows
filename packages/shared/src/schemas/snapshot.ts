import { z } from 'zod';
import { BaseSchema } from './base.js';

/**
 * Base snapshots: a point-in-time copy of a base (schema, records, links, attachment
 * references) stored compressed in object storage, restorable to a new base of the same
 * workspace. Manual ("Snapshot now") or automatic (daily, for bases changed since their last
 * snapshot); both are kept for the workspace's retention, then deleted.
 */

/** The default retention of a workspace's snapshots (self-hosted; plans gate it in M5). */
export const SNAPSHOT_RETENTION_DAYS = 30;
export const MAX_SNAPSHOT_RETENTION_DAYS = 365;
/** At most this many snapshots per base; older ones go first by retention. */
export const MAX_SNAPSHOTS_PER_BASE = 100;

export const SNAPSHOT_KINDS = ['manual', 'auto'] as const;

const at = z.iso.datetime({ offset: true });

export const SnapshotSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  /** The base's name when the snapshot was taken. */
  baseName: z.string(),
  kind: z.enum(SNAPSHOT_KINDS),
  /** Compressed size in bytes. */
  size: z.int().min(0),
  tables: z.int().min(0),
  records: z.int().min(0),
  /** Null for automatic snapshots, or when the user is gone. */
  createdBy: z.uuid().nullable(),
  createdAt: at,
  /** createdAt + the workspace's retention: it is deleted from then on. */
  expiresAt: at,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const SnapshotListSchema = z.object({
  snapshots: z.array(SnapshotSchema),
  /** The workspace's retention in days. */
  retentionDays: z.int().min(1),
});
export type SnapshotList = z.infer<typeof SnapshotListSchema>;

export const restoreSnapshotSchema = z
  .object({
    /** The new base's name; "<base name> (restored)" by default. */
    name: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type RestoreSnapshotInput = z.infer<typeof restoreSnapshotSchema>;

/**
 * A restore running in the worker: `running` until the new base exists (`base`) or the
 * restore failed (`error`). Only the person who started it can read it.
 */
export const RestoreJobSchema = z.object({
  id: z.uuid(),
  snapshotId: z.uuid(),
  status: z.enum(['running', 'done', 'failed']),
  base: BaseSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RestoreJob = z.infer<typeof RestoreJobSchema>;

export const SnapshotSettingsSchema = z.object({
  retentionDays: z.int().min(1).max(MAX_SNAPSHOT_RETENTION_DAYS),
});
export type SnapshotSettings = z.infer<typeof SnapshotSettingsSchema>;

export const updateSnapshotSettingsSchema = SnapshotSettingsSchema.strict();
