import type { Comment, FieldMeta, Revision, RevisionChange } from '@openrows/shared';

/**
 * The record's Activity tab: revisions and comments in one timeline, oldest first (the
 * newest at the bottom, next to where comments are written).
 */
export type ActivityItem =
  | { type: 'revision'; id: string; at: string; revision: Revision }
  | { type: 'comment'; id: string; at: string; comment: Comment };

/**
 * Merges loaded revisions (newest first, as paged) and comments. While older revisions are still
 * to load (`complete` false), comments older than the oldest loaded revision wait with them, so
 * the timeline never shows a gap as if nothing happened.
 */
export function activityItems(
  revisions: readonly Revision[],
  comments: readonly Comment[],
  complete: boolean
): ActivityItem[] {
  const oldest = revisions.at(-1)?.at;
  const items: ActivityItem[] = [
    ...revisions.map((r) => ({ type: 'revision' as const, id: r.id, at: r.at, revision: r })),
    ...comments
      .filter((c) => complete || oldest === undefined || c.createdAt >= oldest)
      .map((c) => ({ type: 'comment' as const, id: c.id, at: c.createdAt, comment: c })),
  ];
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

/** What a revision did, after the actor's name ("changed Status and Due"). */
export function revisionVerb(revision: Revision, fieldsById: ReadonlyMap<string, FieldMeta>) {
  switch (revision.kind) {
    case 'created':
      return 'created this record';
    case 'deleted':
      return 'deleted this record';
    case 'restored':
      return 'restored this record from the trash';
    case 'updated': {
      const names = revision.changes.map((c) => fieldsById.get(c.fieldId)?.name ?? 'a field');
      const list =
        names.length <= 2
          ? names.join(' and ')
          : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
      return revision.restoredFrom ? `restored ${list}` : `changed ${list}`;
    }
  }
}

/** Whether a change's values can be shown with the field's current renderer (same type). */
export const sameType = (change: RevisionChange, field: FieldMeta | undefined) =>
  field !== undefined && field.type === change.type;

/** Empty values (shown as "empty" rather than a blank cell). */
export function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** A value of a field that changed type since, as plain text. */
export function plainValue(value: unknown): string {
  if (isEmptyValue(value)) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === 'object' && v !== null
          ? String(
              (v as { name?: unknown; filename?: unknown }).name ??
                (v as { filename?: unknown }).filename ??
                ''
            )
          : String(v)
      )
      .join(', ');
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
