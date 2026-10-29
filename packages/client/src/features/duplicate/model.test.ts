import type { Workspace } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { canDuplicateBase, copyName, progressLabel, targetWorkspaces } from './model';

const ws = (id: string, role: Workspace['role']): Workspace => ({
  id,
  name: id,
  role,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
});

describe('duplicate base model', () => {
  it('lets creators and owners duplicate', () => {
    expect(canDuplicateBase('owner')).toBe(true);
    expect(canDuplicateBase('creator')).toBe(true);
    expect(canDuplicateBase('editor')).toBe(false);
    expect(canDuplicateBase(undefined)).toBe(false);
  });

  it('offers only workspaces where one may add bases', () => {
    const list = [ws('a', 'owner'), ws('b', 'editor'), ws('c', 'creator'), ws('d', null)];
    expect(targetWorkspaces(list).map((w) => w.id)).toEqual(['a', 'c']);
  });

  it('names the copy like the server', () => {
    expect(copyName('Roadmap')).toBe('Roadmap copy');
    expect(copyName('x'.repeat(255))).toHaveLength(255);
  });

  it('counts the records copied so far', () => {
    expect(progressLabel(undefined)).toBe('Copying…');
    expect(progressLabel({ withRecords: false, progress: { records: 0, totalRecords: 0 } })).toBe(
      'Copying…'
    );
    expect(
      progressLabel({ withRecords: true, progress: { records: 1200, totalRecords: 2000 } })
    ).toBe('Copying records… 1,200 of 2,000');
  });
});
