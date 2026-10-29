import type { PresencePeer } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  cellKeyOf,
  cellPresence,
  cellPresenceLabel,
  namesLabel,
  people,
  recordViewers,
} from './presence-model';

const REC = '0190a000-0000-7000-8000-0000000000a2';
const FIELD = '0190a000-0000-7000-8000-0000000000a3';

const peer = (
  n: number,
  user: number,
  state: Partial<PresencePeer['state']> = {}
): PresencePeer => ({
  connectionId: `0190a000-0000-7000-8000-00000000010${n}`,
  userId: `0190a000-0000-7000-8000-00000000020${user}`,
  name: `Person ${user}`,
  initials: `P${user}`,
  color: 'blue',
  state: { recordId: null, fieldId: null, editing: false, expandedRecordId: null, ...state },
});

describe('presence model', () => {
  it('lists each person once, in arrival order, with the directory name when known', () => {
    const peers = [peer(1, 1), peer(2, 2), peer(3, 1)];
    const byId = new Map([
      [
        peers[1]?.userId ?? '',
        { id: peers[1]?.userId ?? '', name: 'Ben Brown', initials: 'BB', color: 'red' as const },
      ],
    ]);
    expect(people(peers, byId).map((p) => [p.name, p.initials, p.color])).toEqual([
      ['Person 1', 'P1', 'blue'],
      ['Ben Brown', 'BB', 'blue'],
    ]);
  });

  it('maps selected cells to people, one marker per person, editing if any tab edits', () => {
    const cells = cellPresence([
      peer(1, 1, { recordId: REC, fieldId: FIELD }),
      peer(2, 1, { recordId: REC, fieldId: FIELD, editing: true }),
      peer(3, 2, { recordId: REC, fieldId: FIELD }),
      peer(4, 3, { recordId: REC }),
    ]);
    expect([...cells.keys()]).toEqual([cellKeyOf(REC, FIELD)]);
    expect(cells.get(cellKeyOf(REC, FIELD))?.map((c) => [c.person.initials, c.editing])).toEqual([
      ['P1', true],
      ['P2', false],
    ]);
  });

  it('finds who has a record open, and names them', () => {
    const peers = [
      peer(1, 1, { expandedRecordId: REC }),
      peer(2, 2),
      peer(3, 3, { expandedRecordId: REC }),
    ];
    expect(recordViewers(peers, REC).map((p) => p.initials)).toEqual(['P1', 'P3']);
    const list = [1, 2, 3, 4].map((n) => people([peer(n, n)])[0]).filter((p) => p !== undefined);
    expect(namesLabel(list.slice(0, 1))).toBe('Person 1');
    expect(namesLabel(list.slice(0, 2))).toBe('Person 1 and Person 2');
    expect(namesLabel(list.slice(0, 3))).toBe('Person 1, Person 2 and Person 3');
    expect(namesLabel(list)).toBe('Person 1, Person 2 and 2 others');
  });

  it('describes a marked cell', () => {
    const [p1, p2, p3] = [1, 2, 3].map((n) => people([peer(n, n)])[0]);
    if (!p1 || !p2 || !p3) throw new Error('people');
    expect(cellPresenceLabel([{ person: p1, editing: false }])).toBe('Person 1 is here');
    expect(cellPresenceLabel([{ person: p1, editing: true }])).toBe('Person 1 is editing');
    expect(
      cellPresenceLabel([
        { person: p1, editing: false },
        { person: p2, editing: true },
        { person: p3, editing: false },
      ])
    ).toBe('Person 2 is editing, Person 1 and Person 3 are here');
  });
});
