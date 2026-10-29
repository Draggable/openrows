import { describe, expect, it } from 'vitest';
import {
  greeting,
  initials,
  movedPosition,
  nextFreeName,
  nextNumberedName,
  positionBetween,
} from './names';

describe('names', () => {
  it('finds a free name, case-insensitively', () => {
    expect(nextFreeName('Table', [])).toBe('Table');
    expect(nextFreeName('Table', ['table', 'Table 2'])).toBe('Table 3');
    expect(nextNumberedName('Table', ['Table 1'])).toBe('Table 2');
    expect(nextNumberedName('Table', ['Table 1', 'table 3', 'Tasks'])).toBe('Table 4');
  });

  it('places positions between neighbours', () => {
    expect(positionBetween()).toBe(1);
    expect(positionBetween(undefined, 1)).toBe(0);
    expect(positionBetween(3)).toBe(4);
    expect(positionBetween(1, 2)).toBe(1.5);
  });

  it('moves an item up or down by one', () => {
    const items = [{ position: 1 }, { position: 2 }, { position: 3 }];
    expect(movedPosition(items, 0, -1)).toBeNull();
    expect(movedPosition(items, 2, 1)).toBeNull();
    expect(movedPosition(items, 1, -1)).toBe(0); // before the first
    expect(movedPosition(items, 2, -1)).toBe(1.5); // between first and second
    expect(movedPosition(items, 0, 1)).toBe(2.5); // between second and third
    expect(movedPosition(items, 1, 1)).toBe(4); // after the last
  });

  it('greets by time of day and makes initials', () => {
    expect(greeting(new Date(2026, 0, 1, 9))).toBe('Good morning');
    expect(greeting(new Date(2026, 0, 1, 14))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 0, 1, 21))).toBe('Good evening');
    // By the hour in the given time zone, with a fallback when it isn't known.
    const at = new Date('2026-10-26T00:30:00Z');
    expect(greeting(at, 'UTC')).toBe('Good evening');
    expect(greeting(at, 'Europe/Berlin')).toBe('Good evening');
    expect(greeting(at, 'Asia/Tokyo')).toBe('Good morning');
    expect(greeting(at, 'America/Los_Angeles')).toBe('Good afternoon');
    expect(greeting(at, null)).toBe('Welcome back');
    expect(greeting(at, 'Not/AZone')).toBe('Welcome back');
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('ada@example.test')).toBe('AE');
  });
});
