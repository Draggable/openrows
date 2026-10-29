import { describe, expect, it } from 'vitest';
import {
  aiCreditsFor,
  formatUsageBytes,
  usageLevel,
  usageWarnings,
  usageWarningText,
  type WorkspaceUsage,
} from './usage.js';

const BASE_A = '0190a6c0-0000-7000-8000-00000000000a';
const BASE_B = '0190a6c0-0000-7000-8000-00000000000b';

function usage(over: Partial<WorkspaceUsage> = {}): Omit<WorkspaceUsage, 'upgradeUrl'> {
  return {
    workspaceId: '0190a6c0-0000-7000-8000-000000000001',
    plan: { id: 'free', name: 'Free' },
    period: { start: '2026-10-01', end: '2026-11-01' },
    bases: [],
    attachmentBytes: { used: 0, limit: 1024 ** 3 },
    automationRuns: { used: 0, limit: 250 },
    apiCalls: { used: 0, limit: 2000 },
    editors: { used: 1, limit: 5 },
    aiCredits: { used: 0, limit: 100 },
    revisionHistoryDays: 14,
    features: {
      removeBranding: false,
      personalViews: false,
      lockedViews: false,
      editPermissions: false,
      sso: false,
      scim: false,
      auditLogExport: false,
      adminConsole: false,
      dataResidency: false,
    },
    ...over,
  };
}

describe('usageLevel', () => {
  it('is ok under 80%, near from 80% and full at the limit', () => {
    expect(usageLevel({ used: 799, limit: 1000 })).toBe('ok');
    expect(usageLevel({ used: 800, limit: 1000 })).toBe('near');
    expect(usageLevel({ used: 999, limit: 1000 })).toBe('near');
    expect(usageLevel({ used: 1000, limit: 1000 })).toBe('full');
    expect(usageLevel({ used: 1200, limit: 1000 })).toBe('full');
    expect(usageLevel({ used: 10 ** 9, limit: null })).toBe('ok');
    expect(usageLevel({ used: 0, limit: 0 })).toBe('full');
  });
});

describe('usageWarnings', () => {
  it('has none under 80%', () => {
    expect(usageWarnings(usage())).toEqual([]);
  });

  it('lists each limit at 80% or more, bases one by one, full ones first', () => {
    const warnings = usageWarnings(
      usage({
        bases: [
          { baseId: BASE_A, name: 'Roadmap', records: 850, limit: 1000 },
          { baseId: BASE_B, name: 'CRM', records: 1000, limit: 1000 },
        ],
        apiCalls: { used: 1600, limit: 2000 },
        editors: { used: 5, limit: 5 },
      })
    );
    expect(warnings.map((w) => [w.metric, w.level, w.base?.name ?? null])).toEqual([
      ['recordsPerBase', 'full', 'CRM'],
      ['editorsPerWorkspace', 'full', null],
      ['recordsPerBase', 'near', 'Roadmap'],
      ['apiCallsPerMonth', 'near', null],
    ]);
    expect(warnings.find((w) => w.metric === 'apiCallsPerMonth')?.resetsOn).toBe('2026-11-01');
    expect(warnings.find((w) => w.metric === 'editorsPerWorkspace')?.resetsOn).toBeNull();
  });

  it('ignores unlimited meters', () => {
    expect(
      usageWarnings(
        usage({
          bases: [{ baseId: BASE_A, name: 'A', records: 10 ** 6, limit: null }],
          apiCalls: { used: 10 ** 6, limit: null },
        })
      )
    ).toEqual([]);
  });
});

describe('usageWarningText', () => {
  const [near, full] = [
    usageWarnings(usage({ automationRuns: { used: 210, limit: 250 } }))[0],
    usageWarnings(
      usage({ bases: [{ baseId: BASE_A, name: 'Roadmap', records: 1000, limit: 1000 }] })
    )[0],
  ];

  it('says how far and when monthly limits reset', () => {
    expect(near && usageWarningText(near)).toBe(
      "210 of this month's 250 automation runs are used (84%); they reset on November 1."
    );
  });

  it('says what stops at the limit and that forms stop taking responses', () => {
    expect(full && usageWarningText(full)).toContain(
      "Roadmap has reached its plan's 1,000 records"
    );
    expect(full && usageWarningText(full)).toContain("forms aren't accepting responses");
  });

  it('formats bytes', () => {
    expect(formatUsageBytes(512)).toBe('512 bytes');
    expect(formatUsageBytes(1024 ** 3)).toBe('1 GB');
    expect(formatUsageBytes(1.5 * 1024 ** 2)).toBe('1.5 MB');
  });
});

describe('AI credits (#151)', () => {
  it('costs 1 credit per request up to 2,000 tokens, plus 1 per further 2,000 started', () => {
    expect(aiCreditsFor(0)).toBe(1);
    expect(aiCreditsFor(1)).toBe(1);
    expect(aiCreditsFor(2000)).toBe(1);
    expect(aiCreditsFor(2001)).toBe(2);
    expect(aiCreditsFor(4000)).toBe(2);
    expect(aiCreditsFor(4001)).toBe(3);
    expect(aiCreditsFor(Number.NaN)).toBe(1);
    expect(aiCreditsFor(-5)).toBe(1);
  });

  it('warns at 80% and 100% of the month, with the reset day', () => {
    const near = usageWarnings(usage({ aiCredits: { used: 80, limit: 100 } }));
    expect(near).toEqual([
      expect.objectContaining({
        metric: 'aiCreditsPerMonth',
        level: 'near',
        resetsOn: '2026-11-01',
      }),
    ]);
    expect(usageWarningText(near[0] as NonNullable<(typeof near)[0]>)).toBe(
      "80 of this month's 100 AI credits are used (80%); they reset on November 1."
    );
    const full = usageWarnings(usage({ aiCredits: { used: 103, limit: 100 } }));
    expect(full[0]).toMatchObject({ metric: 'aiCreditsPerMonth', level: 'full' });
    expect(usageWarningText(full[0] as NonNullable<(typeof full)[0]>)).toContain(
      'AI features pause until November 1'
    );
  });

  it('has no warning without the instance provider (null) or a limit', () => {
    expect(usageWarnings(usage({ aiCredits: null }))).toEqual([]);
    expect(usageWarnings(usage({ aiCredits: { used: 5000, limit: null } }))).toEqual([]);
  });
});
