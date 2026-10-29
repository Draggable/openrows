import type { Notification } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { badgeCount, notificationTitle } from './model';

const base = {
  actorName: 'Grace',
  recordName: 'Launch',
  fieldName: null,
} as Pick<Notification, 'actorName' | 'recordName' | 'fieldName'>;

describe('notification model (#93)', () => {
  it('caps the badge at 99+', () => {
    expect(badgeCount(1)).toBe('1');
    expect(badgeCount(99)).toBe('99');
    expect(badgeCount(100)).toBe('99+');
  });

  it('says what happened, naming unnamed records', () => {
    const t = (n: Partial<Notification>) => notificationTitle({ ...base, ...n } as Notification);
    expect(t({ kind: 'mention' })).toBe('Grace mentioned you on Launch');
    expect(t({ kind: 'reply', recordName: '  ' })).toBe('Grace replied on Unnamed record');
    expect(t({ kind: 'assigned', fieldName: 'Owner' })).toBe('Grace added you to Owner on Launch');
    expect(t({ kind: 'assigned' })).toBe('Grace assigned you Launch');
  });
});
