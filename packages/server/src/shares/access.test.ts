import { describe, expect, it } from 'vitest';
import {
  checkShareAccess,
  hashSharePassword,
  SHARE_ACCESS_TTL_MS,
  type ShareCredentials,
  shareAccessExpiry,
  shareCookieSigner,
  verifySharePassword,
} from './access.js';

const SHARE = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

describe('share passwords (#98)', () => {
  it('hashes with salted argon2id and verifies only the right password', async () => {
    const a = await hashSharePassword('open sesame');
    const b = await hashSharePassword('open sesame');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await verifySharePassword(a, 'open sesame')).toBe(true);
    expect(await verifySharePassword(a, 'open sesame ')).toBe(false);
  });

  it('refuses anything but an argon2id hash', async () => {
    const sha = '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8';
    expect(await verifySharePassword(sha, 'password')).toBe(false);
    const argon2i = (await hashSharePassword('pw')).replace('$argon2id$', '$argon2i$');
    expect(await verifySharePassword(argon2i, 'pw')).toBe(false);
    expect(await verifySharePassword('$argon2id$garbage', 'pw')).toBe(false);
  });
});

describe('share unlock cookies (#98)', () => {
  const signer = shareCookieSigner('a-test-secret-of-sufficient-length-0123456789');
  const now = Date.UTC(2026, 9, 26, 12);
  const grant = { shareId: SHARE, version: 3, expiresAt: now + 3_600_000 };

  it('opens its own share and password version until it expires', () => {
    const cookie = signer.sign(grant);
    expect(signer.verify(cookie, { shareId: SHARE, version: 3, now })).toBe(true);
    expect(signer.verify(cookie, { shareId: OTHER, version: 3, now })).toBe(false);
    expect(signer.verify(cookie, { shareId: SHARE, version: 4, now })).toBe(false);
    expect(signer.verify(cookie, { shareId: SHARE, version: 3, now: now + 3_600_000 })).toBe(false);
  });

  it('refuses tampered, foreign-key and malformed cookies', () => {
    const cookie = signer.sign(grant);
    const [v, id, version, exp, tag] = cookie.split('.');
    const forged = [
      `${v}.${OTHER}.${version}.${exp}.${tag}`,
      `${v}.${id}.${version}.${Number(exp) + 1}.${tag}`,
      `${v}.${id}.${version}.${exp}.${tag?.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))}`,
      `v2.${id}.${version}.${exp}.${tag}`,
      shareCookieSigner('another-secret-another-secret-another-secret').sign(grant),
      '',
      'a.b.c.d.e',
      `${cookie}.extra`,
      'x'.repeat(500),
    ];
    for (const value of forged) {
      expect(signer.verify(value, { shareId: SHARE, version: 3, now }), value).toBe(false);
    }
    expect(signer.verify(undefined, { shareId: SHARE, version: 3, now })).toBe(false);
  });

  it("lasts 12 hours, or until the share's own expiry when sooner", () => {
    expect(shareAccessExpiry(null, now)).toBe(now + SHARE_ACCESS_TTL_MS);
    expect(shareAccessExpiry(new Date(now + 60_000), now)).toBe(now + 60_000);
    expect(shareAccessExpiry(new Date(now + 2 * SHARE_ACCESS_TTL_MS), now)).toBe(
      now + SHARE_ACCESS_TTL_MS
    );
  });

  it('checks domains before the password', async () => {
    const creds = (
      viewer: { email: string; emailVerified: boolean } | null,
      cookie?: string
    ): ShareCredentials => ({ cookie, viewer: async () => viewer, signer });
    const lock = {
      shareId: SHARE,
      passwordHash: '$argon2id$...',
      passwordVersion: 0,
      allowedDomains: ['example.com'],
    };
    const code = (p: Promise<void>) => p.then(() => 'ok').catch((e: { code: string }) => e.code);
    expect(await code(checkShareAccess(lock, creds(null)))).toBe('SHARE_SIGN_IN_REQUIRED');
    const eve = { email: 'eve@evil-example.com', emailVerified: true };
    expect(await code(checkShareAccess(lock, creds(eve)))).toBe('SHARE_DOMAIN_NOT_ALLOWED');
    const ann = { email: 'ann@example.com', emailVerified: true };
    expect(await code(checkShareAccess(lock, creds(ann)))).toBe('SHARE_PASSWORD_REQUIRED');
    const cookie = signer.sign({ shareId: SHARE, version: 0, expiresAt: Date.now() + 60_000 });
    expect(await code(checkShareAccess(lock, creds(ann, cookie)))).toBe('ok');
    const open = { ...lock, passwordHash: null, allowedDomains: [] };
    expect(await code(checkShareAccess(open, creds(null)))).toBe('ok');
  });
});
