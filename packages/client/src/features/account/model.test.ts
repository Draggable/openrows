import { describe, expect, it } from 'vitest';
import { deletionBlocked, emailMatches, reauthHref, workspaceOutcome } from './model';

const ws = (outcome: 'delete' | 'leave' | 'blocked', others = 0) => ({
  id: '0192f1d2-3c4b-7a6e-8f90-a1b2c3d4e5f6',
  name: 'Team',
  outcome,
  others,
});

describe('account deletion model (#76)', () => {
  it('asks the provider for the password again and comes back to the dialog', () => {
    const url = new URL(reauthHref(), 'http://app.test');
    expect(url.pathname).toBe('/auth/login');
    expect(url.searchParams.get('reauth')).toBe('1');
    expect(url.searchParams.get('returnTo')).toBe('/settings?delete-account=1');
  });

  it('matches the typed email case-insensitively, never without an email', () => {
    expect(emailMatches('ada@example.test', ' ADA@example.test ')).toBe(true);
    expect(emailMatches('ada@example.test', 'ada@example')).toBe(false);
    expect(emailMatches(null, '')).toBe(false);
  });

  it('blocks while a shared workspace has no other owner', () => {
    const base = { email: 'a@b.test', reauthenticatedUntil: null };
    expect(deletionBlocked({ ...base, workspaces: [ws('delete'), ws('leave')] })).toBe(false);
    expect(deletionBlocked({ ...base, workspaces: [ws('blocked', 2)] })).toBe(true);
    expect(workspaceOutcome(ws('blocked', 1))).toContain('1 other person');
    expect(workspaceOutcome(ws('blocked', 3))).toContain('3 other people');
  });
});
