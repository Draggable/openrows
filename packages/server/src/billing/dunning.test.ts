import { describe, expect, it } from 'vitest';
import { billingPageUrl, DUNNING_REMINDER_DAYS, dunningStage } from './dunning.js';
import { graceEnd } from './store.js';

describe('dunning (#132)', () => {
  const since = new Date('2026-11-01T00:00:00Z');
  const end = graceEnd(since);
  const day = (n: number) => new Date(since.getTime() + n * 86_400_000);

  it('ends the grace period 14 days after the payment failed', () => {
    expect(end.toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('moves from failed to the reminder to ended', () => {
    expect(dunningStage(end, day(0))).toBe(1);
    expect(dunningStage(end, day(14 - DUNNING_REMINDER_DAYS - 0.01))).toBe(1);
    expect(dunningStage(end, day(14 - DUNNING_REMINDER_DAYS))).toBe(2);
    expect(dunningStage(end, day(14))).toBe(3);
    expect(dunningStage(end, day(30))).toBe(3);
  });

  it("links to the workspace's Billing page", () => {
    expect(billingPageUrl('https://app.openrows.io', 'w1')).toBe(
      'https://app.openrows.io/w/w1/billing'
    );
  });
});
