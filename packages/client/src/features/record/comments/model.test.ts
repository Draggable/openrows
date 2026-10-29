import type { Collaborator } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { mentionQuery, mentionSuggestions, toBody, toSegments } from './model';

const ADA = '01900000-0000-7000-8000-00000000000a';
const ANN = '01900000-0000-7000-8000-00000000000b';
const BOB = '01900000-0000-7000-8000-00000000000c';
const person = (id: string, name: string, email?: string): Collaborator => ({
  id,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  color: 'blue',
  ...(email ? { email } : {}),
});
const DIRECTORY = [
  person(ADA, 'Ada Lovelace', 'ada@example.test'),
  person(ANN, 'Ann', 'ann@example.test'),
  person(BOB, 'Bob Stone', 'bob@example.test'),
];

describe('comment composer model (#92)', () => {
  it('finds the @query before the caret', () => {
    expect(mentionQuery('Hi @ad', 6)).toEqual({ start: 3, query: 'ad' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail a@b', 8)).toBeNull();
    expect(mentionQuery('Hi @ada there', 13)).toBeNull();
  });

  it('turns chips into tokens on send, whatever the text around them says', () => {
    expect(
      toBody([
        { text: '  Hi ' },
        { userId: ANN, name: 'Ann' },
        { text: ' and @Anna ' },
        { userId: ADA, name: 'Ada Lovelace' },
        { text: '.\n' },
      ])
    ).toBe(`Hi @[Ann](user:${ANN}) and @Anna @[Ada Lovelace](user:${ADA}).`);
    expect(toBody([{ text: '   ' }])).toBe('');
  });

  it('reads a stored body back as chips with the directory names (round trip)', () => {
    const body = `@[Ada Lovelace](user:${ADA}) and @[Ann](user:${ANN}).\nBye`;
    const segments = toSegments(body, (id) => (id === ADA ? 'Ada L.' : undefined));
    expect(segments).toEqual([
      { userId: ADA, name: 'Ada L.' },
      { text: ' and ' },
      { userId: ANN, name: 'Ann' },
      { text: '.\nBye' },
    ]);
    expect(toBody(toSegments(body, () => undefined))).toBe(body);
    // The split marker can't be smuggled in.
    expect(toSegments('a\u00010\u0001b', () => undefined)).toEqual([{ text: 'a0b' }]);
  });

  it('suggests only people with access, best matches first', () => {
    const access = new Set([ADA, ANN]);
    expect(mentionSuggestions(DIRECTORY, access, 'a').map((c) => c.id)).toEqual([ADA, ANN]);
    expect(mentionSuggestions(DIRECTORY, access, 'love').map((c) => c.id)).toEqual([ADA]);
    expect(mentionSuggestions(DIRECTORY, access, 'bob')).toEqual([]);
    expect(mentionSuggestions(DIRECTORY, undefined, '')).toEqual([]);
  });
});
