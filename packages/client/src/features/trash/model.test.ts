import { describe, expect, it } from 'vitest';
import { canPurge, canRestore, deletedAgo, purgeStatus, recordLabel } from './model';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('trash model', () => {
  it('counts the days left and marks overdue items as due for purging', () => {
    expect(purgeStatus(iso(NOW + 30 * DAY), NOW)).toEqual({ due: false, label: '30 days left' });
    expect(purgeStatus(iso(NOW + DAY / 2), NOW)).toEqual({ due: false, label: '1 day left' });
    expect(purgeStatus(iso(NOW), NOW)).toEqual({ due: true, label: 'Will be purged' });
    expect(purgeStatus(iso(NOW - 3 * DAY), NOW)).toEqual({ due: true, label: 'Will be purged' });
  });

  it('says when something was deleted', () => {
    expect(deletedAgo(iso(NOW - 10_000), NOW)).toBe('just now');
    expect(deletedAgo(iso(NOW - 5 * 60_000), NOW)).toBe('5 min ago');
    expect(deletedAgo(iso(NOW - 3 * 3_600_000), NOW)).toBe('3 h ago');
    expect(deletedAgo(iso(NOW - DAY - 1), NOW)).toBe('yesterday');
    expect(deletedAgo(iso(NOW - 12 * DAY), NOW)).toBe('12 days ago');
    // A clock a little behind the server's never says "in the future".
    expect(deletedAgo(iso(NOW + 5000), NOW)).toBe('just now');
  });

  it('follows the roles of the trash routes', () => {
    expect(canRestore('records', 'editor')).toBe(true);
    expect(canRestore('views', 'editor')).toBe(true);
    expect(canRestore('fields', 'editor')).toBe(false);
    expect(canRestore('tables', 'editor')).toBe(false);
    expect(canRestore('tables', 'creator')).toBe(true);
    expect(canRestore('records', 'commenter')).toBe(false);
    expect(canRestore('records', undefined)).toBe(false);
    expect(canPurge('editor')).toBe(false);
    expect(canPurge('creator')).toBe(true);
    expect(canPurge('owner')).toBe(true);
  });

  it('names unnamed records', () => {
    expect(recordLabel('')).toBe('Unnamed record');
    expect(recordLabel('  ')).toBe('Unnamed record');
    expect(recordLabel('Launch')).toBe('Launch');
  });
});
