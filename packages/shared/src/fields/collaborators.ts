import { CHOICE_COLORS, type ChoiceColor } from './choices.js';

/**
 * Helpers of the collaborator directory that user cells, filters and the server share.
 */

/** The filter value that stands for the signed-in user (`createdBy is me`), kept as is in views. */
export const ME_TOKEN = 'me';

/** Most people one directory lists. */
export const MAX_COLLABORATORS = 5000;

/** Up to two initials of a display name (first and last word), upper case; `?` without letters. */
export function userInitials(name: string): string {
  const words = name
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
    .filter((c) => c !== '');
  if (words.length === 0) return '?';
  const first = words[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return (first + last).toLocaleUpperCase('en-US');
}

/** A stable avatar colour for a user id (FNV-1a over the id, onto the chip palette). */
export function userColor(userId: string): ChoiceColor {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return CHOICE_COLORS[h % CHOICE_COLORS.length] ?? 'green';
}
