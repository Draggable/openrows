import { describe, expect, it } from 'vitest';
import { MeResponseSchema } from '../index.js';

describe('MeResponseSchema', () => {
  it('accepts the /api/me body and rejects a malformed one', () => {
    const me = {
      user: {
        id: '0192f1d2-3c4b-7a6e-8f90-a1b2c3d4e5f6',
        email: 'ada@example.test',
        name: 'Ada',
        avatarUrl: null,
        isSystemAdmin: false,
      },
      session: { createdAt: '2026-10-25T10:00:00.000Z', expiresAt: '2026-11-24T10:00:00.000Z' },
    };
    expect(MeResponseSchema.parse(me)).toEqual(me);
    expect(MeResponseSchema.safeParse({ ...me, user: { ...me.user, id: 'x' } }).success).toBe(
      false
    );
  });
});
