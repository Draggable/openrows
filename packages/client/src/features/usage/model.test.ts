import { describe, expect, it } from 'vitest';
import { aiCreditsText, historyText, meterLevel, meterShare, meterText, monthName } from './model';

describe('usage meters (#128)', () => {
  it('text: used and limit, bytes for files, used alone without a limit', () => {
    expect(meterText({ used: 320, limit: 1000 })).toBe('320 / 1,000');
    expect(meterText({ used: 12_345, limit: null })).toBe('12,345');
    expect(meterText({ used: 1536, limit: 1024 ** 3 }, 'bytes')).toBe('1.5 KB / 1.0 GB');
  });

  it('share and level: ok below 80%, near from 80%, full at the limit', () => {
    expect(meterShare({ used: 250, limit: 1000 })).toBe(0.25);
    expect(meterShare({ used: 2000, limit: 1000 })).toBe(1);
    expect(meterShare({ used: 5, limit: null })).toBe(0);
    expect(meterShare({ used: 1, limit: 0 })).toBe(1);
    expect(meterLevel({ used: 799, limit: 1000 })).toBe('ok');
    expect(meterLevel({ used: 800, limit: 1000 })).toBe('near');
    expect(meterLevel({ used: 1000, limit: 1000 })).toBe('full');
    expect(meterLevel({ used: 10 ** 9, limit: null })).toBe('ok');
  });

  it('history windows and the month', () => {
    expect(historyText(14)).toBe('2 weeks');
    expect(historyText(365)).toBe('1 year');
    expect(historyText(1095)).toBe('3 years');
    expect(historyText(45)).toBe('45 days');
    expect(historyText(null)).toBe('Unlimited');
    expect(monthName('2026-10-01')).toBe('October 2026');
  });
});

describe('AI credits (#151)', () => {
  it('explains what a credit is and that a workspace key is free', () => {
    expect(aiCreditsText(100)).toMatch(/1 credit per 2,000 tokens/);
    expect(aiCreditsText(100)).toMatch(/own API key don't count/);
    expect(aiCreditsText(100)).toMatch(/pause until next month/);
    expect(aiCreditsText(null)).not.toMatch(/pause/);
  });
});
