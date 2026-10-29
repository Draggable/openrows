import { describe, expect, it } from 'vitest';
import {
  navigationKey,
  neighbour,
  positionLabel,
  recordUrl,
  relativeTime,
  storedLayout,
  storeLayout,
} from './model';

const key = (k: string, extra: Partial<Parameters<typeof navigationKey>[0]> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: null,
  ...extra,
});

describe('record expand model', () => {
  it('steps to neighbours inside the view and stops at the ends', () => {
    expect(neighbour(0, 3, -1)).toBeNull();
    expect(neighbour(0, 3, 1)).toBe(1);
    expect(neighbour(2, 3, 1)).toBeNull();
    expect(neighbour(null, 3, 1)).toBeNull();
  });

  it('labels the position', () => {
    expect(positionLabel(2, 128)).toBe('Record 3 of 128');
    expect(positionLabel(null, 128)).toBe('Record');
  });

  it('maps up/down and K/J to navigation, but not inside inputs or with modifiers', () => {
    expect(navigationKey(key('ArrowUp'))).toBe(-1);
    expect(navigationKey(key('ArrowDown'))).toBe(1);
    expect(navigationKey(key('k'))).toBe(-1);
    expect(navigationKey(key('j'))).toBe(1);
    expect(navigationKey(key('ArrowDown', { shiftKey: true }))).toBeNull();
    expect(navigationKey(key('x'))).toBeNull();
    const input = document.createElement('input');
    expect(navigationKey(key('ArrowDown', { target: input }))).toBeNull();
    const button = document.createElement('button');
    expect(navigationKey(key('ArrowDown', { target: button }))).toBe(1);
  });

  it('builds the record link from the view URL', () => {
    expect(recordUrl('https://app.openrows.io', '/b/1/2/3', 'r1')).toBe(
      'https://app.openrows.io/b/1/2/3?record=r1'
    );
  });

  it('formats edit times relative to now', () => {
    const now = Date.parse('2026-10-25T12:00:00Z');
    expect(relativeTime('2026-10-25T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-25T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-10-25T10:00:00Z', now)).toBe('2h ago');
    expect(relativeTime('2026-10-23T12:00:00Z', now)).toBe('2 days ago');
    expect(relativeTime('2026-09-01T12:00:00Z', now, 'en-US')).toBe('Sep 1, 2026');
    expect(relativeTime('nope', now)).toBe('');
  });

  it('remembers the layout and survives broken storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(storedLayout(storage)).toBe('modal');
    storeLayout(storage, 'panel');
    expect(storedLayout(storage)).toBe('panel');
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(storedLayout(broken)).toBe('modal');
    expect(() => storeLayout(broken, 'panel')).not.toThrow();
    expect(storedLayout(undefined)).toBe('modal');
  });
});
