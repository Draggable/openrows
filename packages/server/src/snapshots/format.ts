import { z } from 'zod';

/**
 * The snapshot file: gzipped JSON lines. The first line is the header (the base and its
 * live tables with their fields, view sections and views); then sections, each a marker line
 * followed by its rows:
 *
 * - `{"section":"attachments"}`: the base's confirmed attachment rows (references to stored
 *   objects, never the files);
 * - `{"section":"records","table":"<id>"}`: the table's live records, as Postgres' `to_jsonb`
 *   of the physical row (columns by physical name), written and restored without a JavaScript
 *   round trip, so numbers keep their precision;
 * - `{"section":"links","field":"<id>"}`: the junction of the link field that owns it, rows
 *   between live records only.
 *
 * Record lines start with `{"id":` (jsonb orders keys by length), markers with `{"section":`.
 */
export const SNAPSHOT_FORMAT = 'openrows.base-snapshot';
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_CONTENT_TYPE = 'application/gzip';

const json = z.unknown();
const name = z.string().max(10_000);
const text = z.string().max(100_000).nullable();

export const SnapshotFieldSchema = z.object({
  id: z.uuid(),
  name,
  description: text,
  type: z.string().max(64),
  dbColumn: z.string().regex(/^[fl]_[0-9a-f]{32}$/),
  isPrimary: z.boolean(),
  position: z.number(),
  config: json,
  permissions: json,
});
export type SnapshotField = z.infer<typeof SnapshotFieldSchema>;

export const SnapshotViewSchema = z.object({
  id: z.uuid(),
  name,
  type: z.string().max(64),
  position: z.number(),
  config: json,
  personal: z.boolean(),
  locked: z.boolean(),
  sectionId: z.uuid().nullable(),
  createdBy: z.uuid().nullable(),
});
export type SnapshotView = z.infer<typeof SnapshotViewSchema>;

export const SnapshotTableSchema = z.object({
  id: z.uuid(),
  name,
  description: text,
  icon: text,
  position: z.number(),
  permissions: json,
  fields: z.array(SnapshotFieldSchema).max(1000),
  sections: z.array(z.object({ id: z.uuid(), name, position: z.number() })).max(1000),
  views: z.array(SnapshotViewSchema).max(10_000),
});
export type SnapshotTable = z.infer<typeof SnapshotTableSchema>;

export const SnapshotHeaderSchema = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  version: z.literal(SNAPSHOT_VERSION),
  workspaceId: z.uuid(),
  takenAt: z.iso.datetime({ offset: true }),
  base: z.object({
    id: z.uuid(),
    name,
    description: text,
    icon: text,
    color: text,
  }),
  tables: z.array(SnapshotTableSchema).max(1000),
});
export type SnapshotHeader = z.infer<typeof SnapshotHeaderSchema>;

export const SectionSchema = z.discriminatedUnion('section', [
  z.object({ section: z.literal('attachments') }),
  z.object({ section: z.literal('records'), table: z.uuid() }),
  z.object({ section: z.literal('links'), field: z.uuid() }),
]);
export type Section = z.infer<typeof SectionSchema>;

/** An attachment row of the snapshot (snake_case: `to_jsonb` of the row). */
export const SnapshotAttachmentSchema = z.object({
  id: z.uuid(),
  table_id: z.uuid(),
  field_id: z.uuid().nullable(),
  view_id: z.uuid().nullable(),
  storage_key: z.string().min(1).max(1024),
  filename: z.string().max(1024),
  content_type: z.string().max(255),
  size: z.number().int().min(0),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  thumbnail_key: z.string().max(1024).nullable(),
  thumbnail_size: z.number().int().nullable(),
  created_by: z.uuid().nullable(),
  created_at: z.string(),
  confirmed_at: z.string().nullable(),
});

export const isSection = (line: string) => line.startsWith('{"section"');

/** The object key of a snapshot, under `snapshots/` in the attachments bucket. */
export const snapshotKey = (workspaceId: string, baseId: string, id: string) =>
  `snapshots/ws/${workspaceId}/b/${baseId}/${id}.jsonl.gz`;

/** A UUID anywhere in a string (ids in configs, formulas' stored form `{<field id>}`…). */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Every UUID in a JSON value. */
export function uuidsIn(value: unknown): string[] {
  return JSON.stringify(value ?? null).match(UUID) ?? [];
}

/** `value` with every UUID found in `map` replaced by its new id (keys, strings, formulas). */
export function remapIds<T>(value: T, map: ReadonlyMap<string, string>): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value).replace(UUID, (id) => map.get(id) ?? id)) as T;
}

/** The id behind a physical `f_`/`l_<32 hex>` name. */
export function idOfPhysical(name: string): string {
  const hex = name.slice(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
