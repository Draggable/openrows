import { describe, expect, it } from 'vitest';
import { readUserIds, userOptions, userValueLabel } from './model';

const person = (id: string, name: string) => ({
  id,
  name,
  initials: name.slice(0, 1),
  color: 'green' as const,
});

describe('collaborator model', () => {
  const me = person('0190a000-0000-7000-8000-000000000001', 'Ada');
  const bob = person('0190a000-0000-7000-8000-000000000002', 'Bob');

  it('reads user ids from a cell value', () => {
    expect(readUserIds(me.id)).toEqual([me.id]);
    expect(readUserIds([me.id, { id: bob.id }])).toEqual([me.id, bob.id]);
    expect(readUserIds(null)).toEqual([]);
  });

  it('offers me first, then everyone else', () => {
    expect(userOptions([me, bob], me.id).map((o) => [o.value, o.label])).toEqual([
      ['me', 'Me (Ada)'],
      [bob.id, 'Bob'],
    ]);
    expect(userOptions([bob], undefined)[0]).toEqual({ value: 'me', label: 'Me' });
  });

  it('labels filter values', () => {
    const byId = new Map([[bob.id, bob]]);
    expect(userValueLabel('me', byId)).toBe('Me');
    expect(userValueLabel(bob.id, byId)).toBe('Bob');
    expect(userValueLabel(me.id, byId)).toBe('Former member');
  });
});
