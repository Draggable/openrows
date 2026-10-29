import { describe, expect, it } from 'vitest';
import { createCipher } from './crypto.js';

const SECRET = 'a-test-encryption-key-that-is-long-enough';

describe('createCipher', () => {
  const cipher = createCipher(SECRET, 'session-tokens');

  it('round-trips and never repeats a ciphertext', () => {
    const a = cipher.encrypt('refresh-token');
    const b = cipher.encrypt('refresh-token');
    expect(a.equals(b)).toBe(false);
    expect(a.toString('utf8')).not.toContain('refresh-token');
    expect(cipher.decrypt(a)).toBe('refresh-token');
  });

  it('rejects tampered, truncated and foreign ciphertexts', () => {
    const data = cipher.encrypt('refresh-token');
    const tampered = Buffer.from(data);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(cipher.decrypt(tampered)).toBeUndefined();
    expect(cipher.decrypt(data.subarray(0, 20))).toBeUndefined();
    expect(createCipher(SECRET, 'login-transaction').decrypt(data)).toBeUndefined();
    expect(createCipher(`${SECRET}-other`, 'session-tokens').decrypt(data)).toBeUndefined();
  });
});
