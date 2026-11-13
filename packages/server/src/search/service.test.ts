import { SEARCH_EXCERPT_MAX } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { decodeSearchOffset, encodeSearchOffset, excerpt } from './service.js';

const B = '0190a0b0-0000-7000-8000-000000000001';
const T = '0190a0b0-0000-7000-8000-000000000002';

describe('search offsets', () => {
  it('round-trip a base, a table and a record cursor', () => {
    for (const position of [{ b: B }, { b: B, t: T }, { b: B, t: T, c: 'eyJrIjpbXX0' }]) {
      expect(decodeSearchOffset(encodeSearchOffset(position))).toEqual(position);
    }
  });

  it('refuse anything else', () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const offset of [
      'garbage',
      enc(null),
      enc([B]),
      enc({}),
      enc({ b: 'not-a-uuid' }),
      enc({ b: B, t: 'x' }),
      // A record cursor needs its table.
      enc({ b: B, c: 'abc' }),
      enc({ b: B, t: T, c: 5 }),
      enc({ b: B, t: T, c: 'x'.repeat(5001) }),
    ]) {
      expect(decodeSearchOffset(offset), offset).toBeNull();
    }
  });
});

describe('excerpt', () => {
  it('keeps short text whole, on one line', () => {
    expect(excerpt('Knows  Ada\nLovelace well ', 'ada')).toBe('Knows Ada Lovelace well');
  });

  it('cuts long text around the first match, marking the cuts', () => {
    const text = `${'a'.repeat(300)} Lovelace ${'b'.repeat(300)}`;
    const out = excerpt(text, 'LOVELACE');
    expect(out).toHaveLength(SEARCH_EXCERPT_MAX);
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toContain('Lovelace');
  });

  it('starts at the beginning or ends at the end when the match is near either', () => {
    const start = excerpt(`Lovelace ${'b'.repeat(300)}`, 'lovelace');
    expect(start.startsWith('Lovelace')).toBe(true);
    expect(start.endsWith('…')).toBe(true);
    const end = excerpt(`${'a'.repeat(300)} Lovelace`, 'lovelace');
    expect(end.startsWith('…')).toBe(true);
    expect(end.endsWith('Lovelace')).toBe(true);
    expect(end).toHaveLength(SEARCH_EXCERPT_MAX);
  });

  it('shows the beginning when the match is in no single field text', () => {
    const out = excerpt('x'.repeat(300), 'lovelace');
    expect(out).toBe(`${'x'.repeat(SEARCH_EXCERPT_MAX - 1)}…`);
  });
});
