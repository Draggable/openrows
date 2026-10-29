import { describe, expect, it } from 'vitest';
import { noticeDate, noticeWhen } from './model';

describe('notice dates', () => {
  it('says the day in UTC, as the email does', () => {
    expect(noticeDate('2026-12-01T00:00:00.000Z')).toBe('December 1, 2026');
    expect(noticeDate('2026-12-01T23:30:00.000-05:00')).toBe('December 2, 2026');
  });

  it('says whether the change is coming or already in effect', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(noticeWhen({ effectiveAt: '2026-12-01T00:00:00.000Z' }, now)).toBe(
      'Takes effect on December 1, 2026.'
    );
    expect(noticeWhen({ effectiveAt: '2026-11-01T00:00:00.000Z' }, now)).toBe(
      'In effect since November 1, 2026.'
    );
  });
});
