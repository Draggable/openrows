import { describe, expect, it } from 'vitest';
import { v1BaseId } from './admission.js';
import {
  type BucketRequest,
  headersFor,
  MemoryRateLimiter,
  refill,
  retryAfter,
  tightestBucket,
} from './limiter.js';

const base = { perSecond: 5, burst: 10 };
const token = { perSecond: 50, burst: 100 };
const req = (kind: BucketRequest['kind'], key: string, policy = base): BucketRequest => ({
  kind,
  key,
  policy,
});

describe('refill', () => {
  it('adds perSecond tokens a second, up to the burst', () => {
    expect(refill(0, 1000, base)).toBe(5);
    expect(refill(3, 200, base)).toBe(4);
    expect(refill(9, 10_000, base)).toBe(10);
    // A clock that went backwards adds nothing.
    expect(refill(2, -500, base)).toBe(2);
  });
});

describe('MemoryRateLimiter', () => {
  it('allows a burst, refuses past it, and refills over time', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    const results: boolean[] = [];
    for (let i = 0; i < 12; i++) results.push((await limiter.take([req('base', 'b1')])).allowed);
    expect(results).toEqual([...Array(10).fill(true), false, false]);

    now = 200; // one token back at 5 per second
    expect((await limiter.take([req('base', 'b1')])).allowed).toBe(true);
    expect((await limiter.take([req('base', 'b1')])).allowed).toBe(false);
    now = 2200; // full again
    const after = await limiter.take([req('base', 'b1')]);
    expect(after.allowed).toBe(true);
    expect(after.buckets[0]?.level).toBe(9);
  });

  it('keeps buckets apart and takes from all or none', async () => {
    const limiter = new MemoryRateLimiter(() => 0);
    for (let i = 0; i < 10; i++) await limiter.take([req('base', 'b1')]);
    // b1 is empty: the token's bucket isn't charged for the refusal.
    const refused = await limiter.take([req('token', 't1', token), req('base', 'b1')]);
    expect(refused.allowed).toBe(false);
    expect(refused.buckets.map((b) => b.level)).toEqual([100, 0]);
    // Another base is untouched.
    const other = await limiter.take([req('token', 't1', token), req('base', 'b2')]);
    expect(other.allowed).toBe(true);
    expect(other.buckets.map((b) => b.level)).toEqual([99, 9]);
  });
});

describe('headersFor', () => {
  it('describes the tightest bucket', () => {
    const headers = headersFor({
      allowed: true,
      buckets: [
        { kind: 'token', policy: token, level: 80 },
        { kind: 'base', policy: base, level: 6.5 },
      ],
    });
    expect(headers).toEqual({
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '6',
      'RateLimit-Reset': '1',
      'RateLimit-Policy': '10;w=2',
    });
  });

  it('adds Retry-After on a refusal, for the empty bucket', () => {
    const decision = {
      allowed: false,
      buckets: [
        { kind: 'token' as const, policy: token, level: 0.2 },
        { kind: 'base' as const, policy: base, level: 3 },
      ],
    };
    expect(tightestBucket(decision)?.kind).toBe('token');
    expect(headersFor(decision)).toMatchObject({
      'RateLimit-Limit': '100',
      'RateLimit-Remaining': '0',
      'Retry-After': '1',
    });
    expect(retryAfter({ kind: 'base', policy: { perSecond: 0.1, burst: 1 }, level: 0 })).toBe(10);
  });

  it('says nothing without buckets', () => {
    expect(headersFor({ allowed: true, buckets: [] })).toEqual({});
  });
});

describe('v1BaseId', () => {
  const id = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
  it('finds the base of record and meta paths', () => {
    expect(v1BaseId(`/api/v1/${id}/Leads`)).toBe(id);
    expect(v1BaseId(`/api/v1/${id}/Leads/rec/`)).toBe(id);
    expect(v1BaseId(`/api/v1/meta/bases/${id}/tables`)).toBe(id);
    expect(v1BaseId(`/api/v1/${id.toUpperCase()}`)).toBe(id);
  });
  it('ignores paths without one', () => {
    expect(v1BaseId('/api/v1/meta/bases')).toBeUndefined();
    expect(v1BaseId('/api/v1/not-a-uuid/Leads')).toBeUndefined();
    expect(v1BaseId(`/api/bases/${id}`)).toBeUndefined();
  });
});
