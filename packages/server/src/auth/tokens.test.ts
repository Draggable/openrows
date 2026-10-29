import { describe, expect, it } from 'vitest';
import { bearerOf, generateToken, hashSecret, parseToken, tokenPrefix } from './tokens.js';

describe('personal access tokens (#102)', () => {
  it('are or_pat_<publicId>_<secret>, parsed back to the parts, with the secret hashed', () => {
    const { token, publicId, secretHash } = generateToken();
    expect(token).toMatch(/^or_pat_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
    expect(token.startsWith(tokenPrefix(publicId))).toBe(true);
    const parsed = parseToken(token);
    expect(parsed?.publicId).toBe(publicId);
    expect(parsed && hashSecret(parsed.secret)).toBe(secretHash);
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(secretHash).not.toContain(parsed?.secret);
  });

  it('are unique', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(tokens.size).toBe(200);
  });

  it('refuse anything malformed', () => {
    const { token } = generateToken();
    for (const bad of [
      '',
      'or_pat_',
      token.slice(0, -1),
      `${token}x`,
      token.replace('or_pat_', 'or_pak_'),
      token.toUpperCase(),
      ` ${token}`,
    ]) {
      expect(parseToken(bad), bad).toBeNull();
    }
  });

  it('read the bearer credential of an Authorization header', () => {
    expect(bearerOf('Bearer abc')).toBe('abc');
    expect(bearerOf('bearer abc')).toBe('abc');
    expect(bearerOf('Basic abc')).toBeNull();
    expect(bearerOf('Bearer')).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });
});
