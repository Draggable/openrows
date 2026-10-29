import { describe, expect, it } from 'vitest';
import { canManageSnapshots, canSetRetention, formatSize, snapshotSummary } from './model';

describe('snapshot model', () => {
  it('formats sizes', () => {
    expect(formatSize(812)).toBe('812 B');
    expect(formatSize(4300)).toBe('4.2 KB');
    expect(formatSize(13 * 1024 * 1024)).toBe('13 MB');
  });

  it('summarizes a snapshot', () => {
    expect(snapshotSummary({ records: 2000, tables: 5, size: 1_258_291 })).toBe(
      '2,000 records in 5 tables · 1.2 MB'
    );
    expect(snapshotSummary({ records: 1, tables: 1, size: 10 })).toBe('1 record in 1 table · 10 B');
  });

  it('lets creators manage snapshots and owners set the retention', () => {
    expect(canManageSnapshots('creator')).toBe(true);
    expect(canManageSnapshots('editor')).toBe(false);
    expect(canSetRetention('owner')).toBe(true);
    expect(canSetRetention('creator')).toBe(false);
  });
});
