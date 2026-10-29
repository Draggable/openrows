import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../ratelimit/limiter.js';
import { configOutboundLimits, OutboundDeferred, OutboundGate } from './limits.js';

/** A gate on a fake clock: waiting advances it. */
function gate(perMinute: number, burst: number) {
  let now = 1_000_000;
  const waits: number[] = [];
  const g = new OutboundGate(
    new MemoryRateLimiter(() => now),
    configOutboundLimits({ perMinute, burst, concurrency: 2 }),
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
    () => now
  );
  return { g, waits, advance: (ms: number) => (now += ms) };
}

describe('OutboundGate (#124)', () => {
  it('lets a burst through, then waits for the next token within the bound', async () => {
    const { g, waits } = gate(60, 3);
    for (let i = 0; i < 3; i++) await g.acquire('ws-a', 0);
    expect(waits).toEqual([]);
    // One token a second: the fourth request waits about a second.
    await g.acquire('ws-a', 5_000);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1_000);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(1_100);
  });

  it('defers past the bound with when to try again, and never touches another workspace', async () => {
    const { g, advance } = gate(6, 2);
    await g.acquire('noisy', 0);
    await g.acquire('noisy', 0);
    // A token every 10 s: more than the 1 s bound.
    const err = await g.acquire('noisy', 1_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutboundDeferred);
    expect((err as OutboundDeferred).retryAfterSeconds).toBe(10);
    // The quiet workspace's bucket is its own.
    await g.acquire('quiet', 0);
    await g.acquire('quiet', 0);
    advance(10_000);
    await g.acquire('noisy', 0);
  });

  it('is off with a zero rate', async () => {
    const { g, waits } = gate(0, 0);
    for (let i = 0; i < 100; i++) await g.acquire('ws', 0);
    expect(waits).toEqual([]);
  });
});
