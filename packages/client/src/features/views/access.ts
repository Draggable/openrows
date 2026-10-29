import type { UserRole, ViewMeta } from '@openrows/shared';

/**
 * Whether the role may save changes to the view's configuration (layout, filters, sorts, row
 * colour, manual order): editors and up (`view:update`), and on a locked view creators and
 * owners only (`view:lock`). Others keep their changes for the page.
 */
export function canConfigureView(role: UserRole | undefined, view: ViewMeta | undefined): boolean {
  const lockers = role === 'owner' || role === 'creator';
  if (!lockers && role !== 'editor') return false;
  return !view?.locked || lockers;
}

/** Whether the role may lock and unlock views (`view:lock`). */
export function canLockViews(role: UserRole | undefined): boolean {
  return role === 'owner' || role === 'creator';
}
