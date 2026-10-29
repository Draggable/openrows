import { describe, expect, it } from 'vitest';
import { CHOICE_COLORS } from './choices.js';
import { userColor, userInitials } from './collaborators.js';

describe('collaborator avatars', () => {
  it('takes the initials of the first and last word', () => {
    expect(userInitials('Ada Lovelace')).toBe('AL');
    expect(userInitials('ada king lovelace')).toBe('AL');
    expect(userInitials('Zoë')).toBe('Z');
    expect(userInitials('jane.doe@example.test')).toBe('JD');
    expect(userInitials('  ')).toBe('?');
  });

  it('picks a stable palette colour per id', () => {
    const id = '0190a000-0000-7000-8000-000000000001';
    expect(userColor(id)).toBe(userColor(id));
    expect(CHOICE_COLORS).toContain(userColor(id));
    const spread = new Set(
      Array.from({ length: 50 }, (_, i) =>
        userColor(`0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`)
      )
    );
    expect(spread.size).toBeGreaterThan(3);
  });
});
