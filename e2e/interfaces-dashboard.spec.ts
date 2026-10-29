import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { type MockPage, mockInterfaces, PREFIX } from './fixtures/mockInterfaces.js';
import { expect, test } from './helpers/test.js';

// Dashboards against the mocked API: a creator builds a dashboard page (a number and a
// chart, aggregated by the page's data route, mocked here with fixed answers), publishes it; a
// viewer narrows it with a filter element, which goes to the data route. The aggregates
// themselves are checked against the ViewQuery in test/integration/interface-dashboards.test.ts,
// and e2e/interfaces.spec.ts renders a dashboard on the whole stack, live.

type DataBody = { draft: boolean; filters: Record<string, string | boolean> };
type Element = { id: string; type: string; chart?: string };

/** The data route: a number per number element, Stage groups per chart; `done` filters it. */
async function mockData(page: Page, pages: () => MockPage[]) {
  const bodies: DataBody[] = [];
  await page.route('**/api/interfaces/*/pages/*/data', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as DataBody;
    bodies.push(body);
    const pageId = new URL(route.request().url()).pathname.split('/').at(-2);
    const p = pages().find((x) => x.id === pageId);
    const config = (body.draft ? p?.draft : p?.published) as { elements: Element[] } | null;
    const done = Object.values(body.filters).includes('done');
    const elements: Record<string, unknown> = {};
    for (const el of config?.elements ?? []) {
      if (el.type === 'number') {
        elements[el.id] = { type: 'number', value: done ? 8 : 1234, records: done ? 1 : 6 };
      } else if (el.type === 'chart') {
        elements[el.id] = {
          type: 'chart',
          series: null,
          rows: done
            ? [{ key: 'done', values: [1] }]
            : [
                { key: 'todo', values: [3] },
                { key: 'doing', values: [2] },
                { key: 'done', values: [1] },
              ],
          truncated: false,
          records: done ? 1 : 6,
        };
      }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ elements }),
    });
  });
  return bodies;
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Page settings' });
const canvas = (page: Page) => page.getByTestId('interface-canvas');
const draftSaved = (page: Page) =>
  page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(PREFIX));

async function seriousViolations(page: Page) {
  const axe = await new AxeBuilder({ page })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  return axe.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

test('a creator builds and publishes a dashboard of a number and a chart', async ({ page }) => {
  await mockApi(page, { rows: 6, stage: true });
  const state = await mockInterfaces(page, true);
  const bodies = await mockData(page, () => state.interfaces.flatMap((i) => i.pages));
  await page.goto(`/b/${IDS.base}/interfaces`);
  await page.getByRole('main').getByRole('button', { name: 'New interface' }).click();
  const dialog = page.getByRole('dialog', { name: 'New interface' });
  await dialog.getByLabel('Page name').fill('Overview');
  await dialog.getByRole('radio', { name: /Dashboard/ }).check();
  await dialog.getByRole('button', { name: 'Create page' }).click();
  await expect(page).toHaveURL(/edit=true/);

  let saved = draftSaved(page);
  await panel(page).getByRole('button', { name: 'Add number' }).click();
  await saved;
  saved = draftSaved(page);
  await panel(page).getByLabel('Summarize').selectOption({ label: 'Estimate' });
  await saved;
  await expect(panel(page).getByLabel('Aggregate')).toHaveValue('sum');
  await panel(page).getByRole('button', { name: 'Done' }).click();
  saved = draftSaved(page);
  await panel(page).getByRole('button', { name: 'Add chart' }).click();
  await saved;
  await expect(panel(page).getByLabel('Group by (x axis)')).toHaveValue(IDS.stage);
  await panel(page).getByRole('button', { name: 'Done' }).click();

  const draft = state.interfaces[0]?.pages[0]?.draft as unknown as { elements: unknown[] };
  expect(draft.elements).toEqual([
    expect.objectContaining({ type: 'number', fieldId: IDS.estimate, fn: 'sum' }),
    expect.objectContaining({ type: 'chart', chart: 'bar', groupFieldId: IDS.stage }),
  ]);
  // The designer shows the saved draft's data.
  await expect(canvas(page).getByTestId('chart-bar')).toHaveCount(3);
  expect(bodies.at(-1)).toEqual({ draft: true, filters: {} });
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Published$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Preview' }).click();
  const dashboard = page.getByRole('region', { name: 'Dashboard' });
  await expect(dashboard.getByRole('heading', { name: 'Sum of Estimate' })).toBeVisible();
  await expect(dashboard.getByTestId('number-value')).toHaveText('1,234');
  await expect(dashboard.getByRole('heading', { name: 'Records by Stage' })).toBeVisible();
  await expect(dashboard.getByRole('img', { name: 'Records by Stage: chart' })).toBeVisible();
  await expect(dashboard.getByTestId('chart-bar')).toHaveCount(3);
  // The numbers behind the chart, as a table for screen readers.
  await expect(dashboard.getByRole('table', { name: 'Records by Stage' })).toContainText('Doing2');
  // Hovering a group shows its value.
  // (The group's hover target lies over its bars.)
  await dashboard.getByTestId('chart-bar').first().hover({ force: true });
  await expect(page.getByRole('tooltip')).toContainText('To do');
  expect(await seriousViolations(page)).toEqual([]);
});

test("a viewer's filter element narrows the dashboard's numbers and charts", async ({ page }) => {
  await mockApi(page, { rows: 3, stage: true, role: 'read_only' });
  const config = {
    layout: 'dashboard',
    tableId: IDS.table,
    sorts: [],
    fields: [],
    elements: [
      { id: 'stage', type: 'filter', x: 0, y: 0, w: 4, h: 2, fieldId: IDS.stage, label: '' },
      {
        id: 'n',
        type: 'number',
        x: 0,
        y: 2,
        w: 3,
        h: 2,
        label: 'Open work',
        tableId: IDS.table,
        viewId: null,
        fieldId: null,
        fn: 'count',
      },
      {
        id: 'c',
        type: 'chart',
        x: 3,
        y: 2,
        w: 6,
        h: 6,
        label: '',
        tableId: IDS.table,
        viewId: null,
        chart: 'donut',
        groupFieldId: IDS.stage,
        seriesFieldId: null,
        fieldId: null,
        fn: 'count',
        order: 'field',
      },
    ],
  };
  const pages = [
    {
      id: '0190f000-0000-7000-8000-000000000001',
      interfaceId: '0190f000-0000-7000-8000-000000000000',
      name: 'Overview',
      position: 1,
      draft: config,
      published: config,
      publishedAt: '2026-10-28T00:00:00.000Z',
      hasChanges: false,
    },
  ] as unknown as MockPage[];
  await mockInterfaces(page, false, [
    {
      id: '0190f000-0000-7000-8000-000000000000',
      baseId: IDS.base,
      name: 'Team',
      position: 1,
      pages,
    },
  ]);
  const bodies = await mockData(page, () => pages);
  await page.goto(`/b/${IDS.base}/interfaces`);
  const dashboard = page.getByRole('region', { name: 'Dashboard' });
  await expect(dashboard.getByTestId('number-value')).toHaveText('1,234');
  await expect(dashboard.getByTestId('chart-slice')).toHaveCount(3);
  // A donut names its slices in a legend.
  await expect(dashboard.locator('ul').getByText('To do', { exact: true })).toBeVisible();
  expect(bodies.at(-1)).toEqual({ draft: false, filters: {} });
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole('combobox', { name: 'Stage' }).selectOption({ label: 'Done' });
  await expect(dashboard.getByTestId('number-value')).toHaveText('8');
  await expect(dashboard.getByTestId('chart-slice')).toHaveCount(1);
  expect(bodies.at(-1)).toEqual({ draft: false, filters: { stage: 'done' } });
});
