import { describe, expect, it } from 'vitest';
import { dateText, tokenText, usersText } from './model';

describe('SCIM settings model', () => {
  it('describes the token without showing it', () => {
    expect(
      tokenText({ hint: 'abcd', createdAt: '2026-10-29T10:00:00Z', lastUsedAt: null }, 'en-US')
    ).toBe('Token ending in abcd, created Oct 29, 2026, last used never.');
    expect(dateText('2026-01-02T12:00:00Z', 'en-US')).toBe('Jan 2, 2026');
  });

  it('counts provisioned people', () => {
    expect(usersText({ total: 0, active: 0, linked: 0 })).toBe('No one is provisioned yet.');
    expect(usersText({ total: 1, active: 1, linked: 1 })).toBe(
      '1 person provisioned, 1 in the workspace.'
    );
    expect(usersText({ total: 5, active: 4, linked: 2 })).toBe(
      '5 people provisioned, 2 in the workspace, 2 joining at their first sign-in, 1 deactivated.'
    );
  });
});
