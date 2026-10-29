import type { Collaborator, PresencePeer } from '@openrows/shared';

/**
 * Presence helpers, free of React: who to show in the top bar, on which cell and on
 * which expanded record. A person with two tabs is two peers but one avatar.
 */

/** A person on the view, as an avatar shows them (the directory's name when it knows them). */
export type PresencePerson = Pick<Collaborator, 'id' | 'name' | 'initials' | 'color'>;

export function personOf(
  peer: PresencePeer,
  byId?: ReadonlyMap<string, Collaborator>
): PresencePerson {
  const known = byId?.get(peer.userId);
  return {
    id: peer.userId,
    name: known?.name ?? peer.name,
    initials: known?.initials ?? peer.initials,
    color: peer.color,
  };
}

/** Everyone on the view, once per person, in the order they arrived. */
export function people(
  peers: readonly PresencePeer[],
  byId?: ReadonlyMap<string, Collaborator>
): PresencePerson[] {
  const seen = new Map<string, PresencePerson>();
  for (const peer of peers) if (!seen.has(peer.userId)) seen.set(peer.userId, personOf(peer, byId));
  return [...seen.values()];
}

export const cellKeyOf = (recordId: string, fieldId: string) => `${recordId}:${fieldId}`;

/** Someone's selection on a cell: who, and whether their editor is open. */
export interface CellPresence {
  person: PresencePerson;
  editing: boolean;
}

/** The selected cells of everyone on the view, by `recordId:fieldId` (one entry per person). */
export function cellPresence(
  peers: readonly PresencePeer[],
  byId?: ReadonlyMap<string, Collaborator>
): Map<string, CellPresence[]> {
  const cells = new Map<string, CellPresence[]>();
  const placed = new Set<string>();
  for (const peer of peers) {
    const { recordId, fieldId, editing } = peer.state;
    if (!recordId || !fieldId) continue;
    const key = cellKeyOf(recordId, fieldId);
    // One person's two tabs on one cell: one marker, editing if either edits.
    const mark = `${peer.userId}|${key}`;
    const list = cells.get(key) ?? [];
    if (placed.has(mark)) {
      const mine = list.find((c) => c.person.id === peer.userId);
      if (mine && editing) mine.editing = true;
      continue;
    }
    placed.add(mark);
    list.push({ person: personOf(peer, byId), editing });
    cells.set(key, list);
  }
  return cells;
}

/** Who else has `recordId` open in the record expand view. */
export function recordViewers(
  peers: readonly PresencePeer[],
  recordId: string,
  byId?: ReadonlyMap<string, Collaborator>
): PresencePerson[] {
  return people(
    peers.filter((p) => p.state.expandedRecordId === recordId),
    byId
  );
}

/** "Ada", "Ada and Ben", "Ada, Ben and 2 others". */
export function namesLabel(list: readonly PresencePerson[]): string {
  const names = list.map((p) => p.name);
  if (names.length <= 2) return names.join(' and ');
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** A marked cell's description: "Ada is here", "Ada is editing", "Ada and Ben are here". */
export function cellPresenceLabel(here: readonly CellPresence[]): string {
  const editing = here.filter((c) => c.editing).map((c) => c.person);
  const idle = here.filter((c) => !c.editing).map((c) => c.person);
  const part = (list: PresencePerson[], verb: string) =>
    `${namesLabel(list)} ${list.length === 1 ? 'is' : 'are'} ${verb}`;
  return [editing.length > 0 && part(editing, 'editing'), idle.length > 0 && part(idle, 'here')]
    .filter(Boolean)
    .join(', ');
}
