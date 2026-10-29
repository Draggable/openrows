import { roleAllows, type UserRole } from '@openrows/shared';

/** The tabs of a base's Trash dialog. */
export const TRASH_TABS = ['records', 'fields', 'views', 'tables'] as const;
export type TrashTab = (typeof TRASH_TABS)[number];

export const TAB_LABELS: Record<TrashTab, string> = {
  records: 'Records',
  fields: 'Fields',
  views: 'Views',
  tables: 'Tables',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long an item has left in the trash: past its purge date it "will be purged" (
 * until it runs the item can still be restored).
 */
export function purgeStatus(purgeAfter: string, now: number): { due: boolean; label: string } {
  const left = Math.ceil((Date.parse(purgeAfter) - now) / DAY_MS);
  if (left <= 0) return { due: true, label: 'Will be purged' };
  return { due: false, label: left === 1 ? '1 day left' : `${left} days left` };
}

/** When an item was deleted, relative to `now`: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function deletedAgo(deletedAt: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(deletedAt));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Who may restore what (the server decides; this only hides buttons). */
export function canRestore(tab: TrashTab, role: UserRole | undefined): boolean {
  if (!role) return false;
  switch (tab) {
    case 'records':
      return roleAllows(role, 'record:delete');
    case 'views':
      return roleAllows(role, 'view:restore');
    case 'fields':
      return roleAllows(role, 'field:restore');
    case 'tables':
      return roleAllows(role, 'table:restore');
  }
}

/** "Delete permanently" is for creators and owners. */
export const canPurge = (role: UserRole | undefined) => !!role && roleAllows(role, 'table:purge');

/** A record's name in the trash: its primary field, or a placeholder. */
export const recordLabel = (name: string) => (name.trim() === '' ? 'Unnamed record' : name);
