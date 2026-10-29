import { DEFAULT_REVISION_RETENTION_DAYS } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { revisionRetentionDays } from './retention.js';

describe('revisionRetentionDays (#94)', () => {
  it('defaults to a year', () => {
    expect(revisionRetentionDays({})).toBe(DEFAULT_REVISION_RETENTION_DAYS);
    expect(revisionRetentionDays({ REVISION_RETENTION_DAYS: ' ' })).toBe(365);
  });

  it('takes a whole number of days', () => {
    expect(revisionRetentionDays({ REVISION_RETENTION_DAYS: '30' })).toBe(30);
  });

  it.each(['0', '-5', '1.5', 'forever', '36501'])('refuses %s', (value) => {
    expect(() => revisionRetentionDays({ REVISION_RETENTION_DAYS: value })).toThrow(
      /REVISION_RETENTION_DAYS/
    );
  });
});
