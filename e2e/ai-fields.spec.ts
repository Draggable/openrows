import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// AI fields against the mocked API: the grid shows answers (a select answer as its
// option's chip), "Generating…" while the worker is on a cell and an error mark with its
// message; the column menu regenerates and stops; the field editor writes a prompt with field
// tokens. Needs only the built client.

const AI = '00000005-0000-4000-8000-00000000a1a1';
const CHOICES = [
  { id: 'bug', name: 'Bug', color: 'red' },
  { id: 'feature', name: 'Feature', color: 'green' },
];
const grid = (page: Page) => page.getByRole('grid');
const header = (page: Page, name: string) =>
  grid(page).getByRole('columnheader', { name, exact: true });
const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function open(page: Page, available = true) {
  const api = await mockApi(page, {
    rows: 3,
    demo: {
      names: ['Crash on save', 'Dark mode', 'Export'],
      fields: [
        {
          id: AI,
          name: 'Category',
          type: 'ai',
          position: 2,
          options: {
            prompt: `Classify {${IDS.notes}}`,
            output: 'singleSelect',
            choices: CHOICES,
            referencedFieldIds: [IDS.notes],
          },
        },
      ],
      cells: (i) => ({ [AI]: i === 0 ? 'Bug' : null }),
    },
  });
  await page.route(`**/api/workspaces/${IDS.workspace}/ai`, (route) =>
    json(route, { workspaceId: IDS.workspace, available, source: available ? 'instance' : null })
  );
  const generated: unknown[] = [];
  const state = { pending: 1, canceled: 0 };
  await page.route(`**/api/fields/${AI}/ai**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/generate')) {
      generated.push(route.request().postDataJSON());
      state.pending = 3;
      return json(route, { queued: 3 });
    }
    if (url.pathname.endsWith('/cancel')) {
      state.canceled = state.pending;
      state.pending = 0;
      return json(route, { canceled: state.canceled });
    }
    return json(route, {
      fieldId: AI,
      available,
      counts: { pending: state.pending, done: 1, error: 1, canceled: state.canceled },
      cells: [
        {
          recordId: recordId(1),
          status: state.pending ? 'pending' : 'canceled',
          error: null,
          updatedAt: '2026-10-28T10:00:00.000Z',
        },
        {
          recordId: recordId(2),
          status: 'error',
          error: 'The answer "Question" isn\'t one of the options of Category.',
          updatedAt: '2026-10-28T10:00:00.000Z',
        },
      ],
    });
  });
  await page.goto(GRID_URL);
  await expect(page.getByTestId('record-count')).toHaveText('3 records');
  return { api, generated };
}

/** The mock's record ids (`uuid(6, i)` in e2e/fixtures/mockApi.ts). */
function recordId(i: number): string {
  return `00000006-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
}

test('shows answers, generation state and errors, and regenerates from the column menu', async ({
  page,
}) => {
  const { generated } = await open(page);
  const rows = grid(page).getByRole('row');
  // Record 1: the answer as its option's chip; record 2: generating; record 3: failed.
  await expect(rows.nth(1).getByText('Bug', { exact: true })).toBeVisible();
  await expect(rows.nth(2).getByText('Generating…')).toBeVisible();
  await expect(rows.nth(3).getByLabel('Generation failed')).toBeVisible();

  await header(page, 'Category').getByRole('button').click();
  await expect(page.getByText('1 generating, 1 failed')).toBeVisible();
  await page.getByRole('menuitem', { name: 'Regenerate all' }).click();
  await expect(page.getByText('Generating 3 answers')).toBeVisible();
  expect(generated).toEqual([{ scope: 'all' }]);

  await header(page, 'Category').getByRole('button').click();
  await page.getByRole('menuitem', { name: 'Stop generating' }).click();
  await expect(page.getByText('Stopped 3 pending')).toBeVisible();
});

test('creates an AI field with a prompt over other fields', async ({ page }) => {
  const { api } = await open(page);
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByLabel('Field name').fill('Summary');
  await page.getByRole('combobox', { name: 'Search field types' }).fill('AI');
  // "AI" matches Email too: pick the option.
  await page.getByRole('option', { name: 'AI', exact: true }).click();
  const prompt = page.getByLabel('Prompt');
  await prompt.fill('Summarize ');
  await page
    .getByRole('group', { name: 'Insert a field' })
    .getByRole('button', { name: 'Notes' })
    .click();
  await expect(prompt).toHaveValue('Summarize {Notes}');
  await page.getByLabel('Output').selectOption({ label: 'Summary' });
  // The AI options (the popover itself is the field editor's, checked elsewhere).
  const results = await new AxeBuilder({ page }).include('[role="dialog"] form').analyze();
  expect(results.violations).toEqual([]);
  await page.getByRole('button', { name: 'Create field' }).click();
  await expect(header(page, 'Summary')).toBeVisible();
  expect(api.fieldWrites.at(-1)).toMatchObject({
    call: `POST /api/tables/${IDS.table}/fields`,
    body: {
      name: 'Summary',
      type: 'ai',
      options: {
        prompt: `Summarize {${IDS.notes}}`,
        referencedFieldIds: [IDS.notes],
        output: 'summary',
      },
    },
  });
});

test('offers no AI type while the workspace has no AI provider', async ({ page }) => {
  await open(page, false);
  await page.getByRole('button', { name: 'Add field' }).click();
  await page.getByRole('combobox', { name: 'Search field types' }).fill('AI');
  await expect(page.getByRole('option', { name: 'Email', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'AI', exact: true })).toHaveCount(0);
});
