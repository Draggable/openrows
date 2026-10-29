import { type Collaborator, ME_TOKEN } from '@openrows/shared';

/** The user ids in a user cell's value (one for createdBy, any number for user fields). */
export function readUserIds(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((v) => {
    if (typeof v === 'string') return [v];
    if (typeof v === 'object' && v !== null && 'id' in v && typeof v.id === 'string') return [v.id];
    return [];
  });
}

/** One option of the filter's user picker: `me` first, then everyone else by name. */
export interface UserOption {
  value: string;
  label: string;
  person?: Collaborator;
}

export function userOptions(list: readonly Collaborator[], meId: string | undefined): UserOption[] {
  const me = list.find((c) => c.id === meId);
  return [
    { value: ME_TOKEN, label: me ? `Me (${me.name})` : 'Me', ...(me ? { person: me } : {}) },
    ...list.filter((c) => c.id !== meId).map((c) => ({ value: c.id, label: c.name, person: c })),
  ];
}

/** A display name for a filter value (`me` or a user id). */
export function userValueLabel(value: string, byId: ReadonlyMap<string, Collaborator>): string {
  if (value === ME_TOKEN) return 'Me';
  return byId.get(value)?.name ?? 'Former member';
}
