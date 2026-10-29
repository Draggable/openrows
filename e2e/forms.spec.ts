import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The form view builder against a mocked API (e2e/fixtures/mockApi.ts with `form`: a
// form view "Feature request" with Name and Stage on it). The builder's field list is on the
// left, the live preview on the right.

const builder = (page: Page) => page.getByRole('complementary', { name: 'Form builder' });
const preview = (page: Page) => page.getByRole('region', { name: 'Form preview' });
const formFields = (page: Page) => builder(page).getByRole('list', { name: 'Form fields' });
const fieldButton = (page: Page, fieldId: string) =>
  formFields(page).locator(`[data-form-field="${fieldId}"] [data-field-button]`);

test('builds a form with a conditional field and the preview follows; axe-clean', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 3, form: true });
  await page.goto(GRID_URL);
  await expect(preview(page).getByRole('heading', { name: 'Feature request' })).toBeVisible();
  await expect(preview(page).getByTestId('form-preview-field')).toHaveCount(2);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    []
  );

  // Add Notes and give it a label: the preview shows it at once.
  await builder(page).getByRole('button', { name: 'Add Notes' }).click();
  await expect(formFields(page).getByRole('listitem')).toHaveCount(3);
  await formFields(page).getByRole('button', { name: 'Notes', exact: true }).click();
  const settings = builder(page).getByRole('group', { name: 'Notes settings' });
  await settings.getByLabel('Label').fill('Tell us more');
  await settings.getByLabel('Required').check();
  await expect(preview(page).getByText('Tell us more')).toBeVisible();

  // Show it only when Stage is Doing.
  await settings.getByLabel('Show only when conditions match').check();
  await settings.getByLabel('Field', { exact: true }).selectOption({ label: 'Stage' });
  await settings.getByLabel('Value of Stage').selectOption({ label: 'Doing' });
  await expect(preview(page).getByText('Tell us more')).toHaveCount(0);
  await expect(preview(page).getByTestId('form-hidden-count')).toHaveText(
    '1 field shows when its conditions match.'
  );
  await expect
    .poll(() => api.viewPatches.at(-1))
    .toEqual({
      form: {
        fields: [
          { fieldId: IDS.name },
          { fieldId: IDS.stage },
          {
            fieldId: IDS.notes,
            label: 'Tell us more',
            required: true,
            condition: {
              conjunction: 'and',
              conditions: [{ fieldId: IDS.stage, operator: 'is', value: 'doing' }],
            },
          },
        ],
      },
    });

  // Answering Stage in the preview shows and hides it.
  const stage = preview(page).getByLabel('Stage', { exact: true });
  await stage.selectOption({ label: 'Doing' });
  await expect(preview(page).getByText('Tell us more')).toBeVisible();
  await expect(preview(page).getByTestId('form-hidden-count')).toHaveCount(0);
  await stage.selectOption({ label: 'To do' });
  await expect(preview(page).getByText('Tell us more')).toHaveCount(0);

  // The condition is saved: after a reload the field still waits for Stage.
  await page.reload();
  await expect(formFields(page).getByRole('listitem')).toHaveCount(3);
  await expect(preview(page).getByTestId('form-hidden-count')).toBeVisible();
  await preview(page).getByLabel('Stage', { exact: true }).selectOption({ label: 'Doing' });
  await expect(preview(page).getByText('Tell us more')).toBeVisible();
});

test('reorders fields with the keyboard, keeping conditioned fields below their source', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 3, form: true });
  await page.goto(GRID_URL);
  const names = () => formFields(page).locator('[data-field-button]').allInnerTexts();
  await expect.poll(names).toEqual(['Name', 'Stage']);

  await fieldButton(page, IDS.name).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(names).toEqual(['Stage', 'Name']);
  await expect(fieldButton(page, IDS.name)).toBeFocused();
  await expect
    .poll(() => api.viewPatches.at(-1))
    .toEqual({ form: { fields: [{ fieldId: IDS.stage }, { fieldId: IDS.name }] } });
  await expect(preview(page).getByTestId('form-preview-field').first()).toHaveAttribute(
    'data-field-id',
    IDS.stage
  );

  // Name shows only when Stage has an answer, so it can't move above Stage.
  await fieldButton(page, IDS.name).click();
  const settings = builder(page).getByRole('group', { name: 'Name settings' });
  await settings.getByLabel('Show only when conditions match').check();
  await fieldButton(page, IDS.name).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(
    page.getByText('Name shows depending on Stage, so it stays below it.')
  ).toBeVisible();
  await expect.poll(names).toEqual(['Stage', 'Name']);

  // Removing Stage drops Name's condition with it.
  await formFields(page).getByRole('button', { name: 'Remove Stage from the form' }).click();
  await expect.poll(names).toEqual(['Name']);
  await expect(builder(page).getByRole('button', { name: 'Add Stage' })).toBeVisible();
  await expect
    .poll(() => api.viewPatches.at(-1))
    .toEqual({ form: { fields: [{ fieldId: IDS.name, condition: null }] } });
});

test('edits the title, submit label and an https-only redirect in Settings', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, form: true });
  await page.goto(GRID_URL);
  await builder(page).getByRole('tab', { name: 'Settings' }).click();
  await builder(page).getByLabel('Title').fill('Ideas box');
  await builder(page).getByLabel('Submit button').fill('Send idea');
  await expect(preview(page).getByRole('heading', { name: 'Ideas box' })).toBeVisible();
  await expect(preview(page).getByRole('button', { name: 'Send idea' })).toBeVisible();

  await builder(page).getByLabel('Redirect to a URL').check();
  const url = builder(page).getByLabel('Redirect URL');
  await url.fill('http://example.com/thanks');
  await expect(builder(page).getByText('Use a full https:// address.')).toBeVisible();
  await expect(url).toHaveAttribute('aria-invalid', 'true');
  await url.fill('https://example.com/thanks');
  await expect(builder(page).getByText('Use a full https:// address.')).toHaveCount(0);
  await expect
    .poll(() => api.viewPatches.at(-1))
    .toMatchObject({
      form: { afterSubmit: 'redirect', redirectUrl: 'https://example.com/thanks' },
    });
  expect(
    api.viewPatches.some(
      (p) =>
        (p as { form?: { redirectUrl?: string } }).form?.redirectUrl === 'http://example.com/thanks'
    )
  ).toBe(false);

  await builder(page).getByLabel('Show “Made with OpenRows”').uncheck();
  await expect(preview(page).getByText('Made with')).toHaveCount(0);
});
