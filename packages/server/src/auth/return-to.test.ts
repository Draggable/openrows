import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './return-to.js';

describe('safeReturnTo', () => {
  it.each([
    ['/bases/1?view=2#x', '/bases/1?view=2#x'],
    ['/', '/'],
    [undefined, '/'],
    ['', '/'],
    ['https://evil.example/', '/'],
    ['//evil.example/', '/'],
    ['/\\evil.example', '/'],
    ['/\t/evil.example', '/'],
    ['javascript:alert(1)', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });
});
