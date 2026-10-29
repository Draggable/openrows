import { roleAllows, type Snapshot, type UserRole } from '@openrows/shared';

/** A byte count for people: "812 B", "4.2 KB", "13 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** What a snapshot holds: "2,000 records in 5 tables · 1.2 MB". */
export function snapshotSummary(s: Pick<Snapshot, 'records' | 'tables' | 'size'>): string {
  const records = `${s.records.toLocaleString('en-US')} ${s.records === 1 ? 'record' : 'records'}`;
  const tables = `${s.tables} ${s.tables === 1 ? 'table' : 'tables'}`;
  return `${records} in ${tables} · ${formatSize(s.size)}`;
}

export const KIND_LABELS: Record<Snapshot['kind'], string> = {
  manual: 'Manual',
  auto: 'Automatic',
};

/** Creators and owners manage snapshots (the server also checks the workspace role on restore). */
export const canManageSnapshots = (role: UserRole | undefined) =>
  !!role && roleAllows(role, 'base:snapshot');

/** Only workspace owners change the retention; a base's owner role means a workspace owner. */
export const canSetRetention = (role: UserRole | undefined) => role === 'owner';

/** The default name of a restored base, as the server gives it. */
export const restoredName = (baseName: string) => `${baseName} (restored)`;
