import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Plan-limit warnings against the mocked API, with seeded counters: the base's banner and
// the workspace's at 80% and at 100%, the Usage page's meters with their reset day and the
// owner's Upgrade button, and a public form that isn't accepting responses at the records limit.
// Needs only the built client.

const PERIOD = { start: '2026-10-01', end: '2026-11-01' };
const PRICING = 'https://openrows.io/pricing';
const BASE_CHROME = ['header', '[data-testid="usage-banner"]'];

function usage(
  records: number,
  runs: number,
  aiCredits: { used: number; limit: number } | null = null
) {
  return {
    workspaceId: IDS.workspace,
    plan: { id: 'free', name: 'Free' },
    period: PERIOD,
    bases: [{ baseId: IDS.base, name: 'Product Roadmap', records, limit: 1000 }],
    attachmentBytes: { used: 1536, limit: 1024 ** 3 },
    automationRuns: { used: runs, limit: 250 },
    apiCalls: { used: 12, limit: 2000 },
    editors: { used: 2, limit: 5 },
    aiCredits,
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
    upgradeUrl: PRICING,
  };
}

const recordsWarning = (used: number) => ({
  metric: 'recordsPerBase',
  level: used >= 1000 ? 'full' : 'near',
  used,
  limit: 1000,
  base: { id: IDS.base, name: 'Product Roadmap' },
  resetsOn: null,
});

const baseWarnings = (used: number) => ({
  workspaceId: IDS.workspace,
  plan: { id: 'free', name: 'Free' },
  warnings: [recordsWarning(used)],
  upgradeUrl: PRICING,
});

/**
 * No serious axe findings, on the whole page or on `only` (the base pages: the banner and the top
 * bar; the grid as a whole has a known finding, a button directly in role=grid, see presence.spec).
 */
async function expectAxeClean(page: Page, only: string[] = []) {
  let axe = new AxeBuilder({ page });
  for (const selector of only) axe = axe.include(selector);
  const results = await axe.withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('a base at 80% of its records: an amber banner with usage and upgrade', async ({ page }) => {
  await mockApi(page, { rows: 3, usageWarnings: baseWarnings(850) });
  await page.goto(GRID_URL);
  const banner = page.getByTestId('usage-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-level', 'near');
  await expect(banner).toContainText('Close to a plan limit');
  await expect(banner).toContainText(
    'Product Roadmap has 850 of the 1,000 records its plan allows (85%).'
  );
  await expect(banner.getByRole('link', { name: 'See usage' })).toHaveAttribute(
    'href',
    `/w/${IDS.workspace}/usage`
  );
  await expect(banner.getByRole('link', { name: 'Upgrade' })).toHaveAttribute('href', PRICING);
  await expectAxeClean(page, BASE_CHROME);

  // Dismissed, it stays away on the next visit until something changes.
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.getByTestId('usage-banner')).toHaveCount(0);
});

test('a base at 100%: a red banner, and adding a record says why it is refused', async ({
  page,
}) => {
  await mockApi(page, { rows: 3, recordsPerBase: 3, usageWarnings: baseWarnings(1000) });
  await page.goto(GRID_URL);
  const banner = page.getByTestId('usage-banner');
  await expect(banner).toHaveAttribute('data-level', 'full');
  await expect(banner).toContainText('A plan limit is reached');
  await expect(banner).toContainText("forms aren't accepting responses");
  await expectAxeClean(page, BASE_CHROME);

  await page.getByRole('button', { name: 'Add record' }).click();
  await expect(page.getByText('This base has 3 of the 3 records its plan allows.')).toBeVisible();
});

test('no banner for editors', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, role: 'editor', usageWarnings: baseWarnings(1000) });
  await page.goto(GRID_URL);
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.getByTestId('usage-banner')).toHaveCount(0);
  expect(api.calls.some((c) => c.includes('usage-warnings'))).toBe(false);
});

test('the Usage page at 80% and 100%: levels, reset day, Upgrade; the workspace banner', async ({
  page,
}) => {
  await mockApi(page, { rows: 3, usage: usage(850, 250) });
  // The workspace with the caller's role: the owner gets the Upgrade button.
  await page.route(`**/api/workspaces/${IDS.workspace}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: IDS.workspace,
        name: 'Ada',
        role: 'owner',
        createdAt: '2026-10-25T10:00:00.000Z',
        updatedAt: '2026-10-25T10:00:00.000Z',
      }),
    })
  );
  await page.goto(`/w/${IDS.workspace}/usage`);
  await expect(page.getByRole('heading', { name: 'Free plan' })).toBeVisible();
  await expect(page.getByTestId('meter-status')).toHaveText(['Limit reached', '80% or more used']);
  await expect(page.getByText('Resets November 1')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Upgrade' })).toHaveAttribute('href', PRICING);
  await expectAxeClean(page);

  await page.goto(`/w/${IDS.workspace}`);
  const banner = page.getByTestId('usage-banner');
  await expect(banner).toHaveAttribute('data-level', 'full');
  await expect(banner).toContainText("This month's 250 automation runs are used up.");
  await expect(banner).toContainText('Product Roadmap has 850 of the 1,000 records');
  await expectAxeClean(page);
  await banner.getByRole('link', { name: 'See usage' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${IDS.workspace}/usage$`));
});

test("hosted AI credits (#151): the Usage page's meter and the banner at the limit", async ({
  page,
}) => {
  await mockApi(page, { rows: 3, usage: usage(10, 12, { used: 100, limit: 100 }) });
  await page.goto(`/w/${IDS.workspace}/usage`);
  const meter = page.getByRole('meter', { name: 'AI credits in October 2026' });
  await expect(meter).toHaveAttribute('aria-valuetext', '100 / 100');
  await expect(page.getByTestId('meter-status')).toHaveText(['Limit reached']);
  await expect(page.getByText(/1 credit per 2,000 tokens/)).toBeVisible();
  await expectAxeClean(page);

  await page.goto(`/w/${IDS.workspace}`);
  const banner = page.getByTestId('usage-banner');
  await expect(banner).toHaveAttribute('data-level', 'full');
  await expect(banner).toContainText("This month's 100 AI credits are used up.");
  await expect(banner).toContainText("the workspace's own API key");
  await expectAxeClean(page);
});

test("a public form at the records limit isn't accepting responses", async ({ page }) => {
  await mockApi(page, { rows: 3 });
  await page.route('**/api/forms/form-token', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        title: 'Feature requests',
        description: null,
        hasCover: false,
        hasLogo: false,
        submitLabel: 'Submit',
        afterSubmit: 'message',
        submitMessage: null,
        redirectUrl: null,
        showBranding: true,
        entries: [],
        fields: [],
        captchaSiteKey: null,
        accepting: false,
      }),
    })
  );
  await page.goto('/f/form-token');
  const notice = page.getByTestId('form-not-accepting');
  await expect(notice).toContainText('Feature requests');
  await expect(notice).toContainText('This form isn’t accepting responses right now.');
  await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);
  await expectAxeClean(page);
});
