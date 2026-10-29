import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/sessions.js';
import { ACTIVITY_TOUCH_MINUTES, activityDue } from './activity.js';

describe('activityDue (#160)', () => {
  const me = { user: { id: 'u1' }, session: {} } as unknown as Principal;
  const now = Date.parse('2026-10-29T12:00:00Z');
  const ago = (minutes: number) => new Date(now - minutes * 60_000);

  it('touches when never recorded or older than the interval', () => {
    expect(activityDue(me, { lastActiveAt: null }, now)).toBe(true);
    expect(activityDue(me, { lastActiveAt: undefined }, now)).toBe(true);
    expect(activityDue(me, { lastActiveAt: ago(ACTIVITY_TOUCH_MINUTES) }, now)).toBe(true);
    expect(activityDue(me, { lastActiveAt: ago(ACTIVITY_TOUCH_MINUTES - 1) }, now)).toBe(false);
  });

  it("never records an impersonating admin's requests", () => {
    const admin = {
      ...me,
      impersonation: { adminId: 'a', adminEmail: null, expiresAt: new Date() },
    };
    expect(activityDue(admin, { lastActiveAt: null }, now)).toBe(false);
  });
});
