import type { ScimState } from '@openrows/shared';

/** When a timestamp happened, for people ("Oct 29, 2026"). */
export function dateText(iso: string | null, locale?: string): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The token in use, without the token: its last characters and when it was made, used. */
export function tokenText(token: NonNullable<ScimState['token']>, locale?: string): string {
  return `Token ending in ${token.hint}, created ${dateText(token.createdAt, locale)}, last used ${dateText(token.lastUsedAt, locale)}.`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How many people the identity provider provisioned, and how many of them are in. */
export function usersText(users: ScimState['users']): string {
  if (users.total === 0) return 'No one is provisioned yet.';
  const inactive = users.total - users.active;
  const waiting = users.active - users.linked;
  return [
    `${plural(users.total, 'person', 'people')} provisioned`,
    `${users.linked} in the workspace`,
    ...(waiting > 0 ? [`${waiting} joining at their first sign-in`] : []),
    ...(inactive > 0 ? [`${inactive} deactivated`] : []),
  ]
    .join(', ')
    .concat('.');
}

/** The group role select's "no role" value. */
export const NO_ROLE = 'none';
