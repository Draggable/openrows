import { describe, expect, it } from 'vitest';
import { unsubscribeToken, verifyUnsubscribeToken } from './unsubscribe.js';

const SECRET = 'a-test-secret-that-is-long-enough-0123456789';
const USER = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

describe('unsubscribe tokens (#93)', () => {
  it('round-trips the user id', () => {
    expect(verifyUnsubscribeToken(SECRET, unsubscribeToken(SECRET, USER))).toBe(USER);
  });

  it('refuses tampered, foreign, other-key and malformed tokens', () => {
    const token = unsubscribeToken(SECRET, USER);
    const mac = token.split('.')[1];
    expect(verifyUnsubscribeToken(SECRET, `${OTHER}.${mac}`)).toBeUndefined();
    expect(verifyUnsubscribeToken(`${SECRET}x`, token)).toBeUndefined();
    expect(verifyUnsubscribeToken(SECRET, `${token}A`)).toBeUndefined();
    expect(verifyUnsubscribeToken(SECRET, `${token}.x`)).toBeUndefined();
    for (const bad of ['', '.', USER, `not-a-uuid.${mac}`, 'x'.repeat(500)]) {
      expect(verifyUnsubscribeToken(SECRET, bad), bad).toBeUndefined();
    }
  });
});
