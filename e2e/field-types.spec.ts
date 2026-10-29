import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi, PEOPLE, recordIdAt } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The remaining field types of against the mocked API (e2e/fixtures/mockApi.ts stores
// writes through the registry and computes buttons with the shared evaluator, as the server
// does): pick collaborators, enter a barcode, open a button's URL, and write rich text that
// renders as formatting (and never as HTML) in the record view.

const grid = (page: Page) => page.getByTestId('grid');
const cell = (page: Page, row: number, col: number) =>
  grid(page).locator(`[data-cell="${row}:${col}"]`);
const editor = (page: Page, field: string) => page.getByRole('dialog', { name: `Edit ${field}` });

const COL = { name: 0, owner: 4, code: 5, open: 6, brief: 7 };

test.use({ viewport: { width: 1800, height: 720 } });

async function expectNoSeriousA11yIssues(page: Page, selector: string) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual([]);
}

test('user: pick several collaborators from the directory', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, m2Types: true });
  await page.goto(GRID_URL);
  await cell(page, 0, COL.owner).click();
  await page.keyboard.press('Enter');
  const picker = editor(page, 'Owner');
  await expect(picker.getByRole('listbox', { name: 'Owner' })).toBeVisible();
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');
  await page.keyboard.type('ada');
  await page.keyboard.press('Enter');
  await page.keyboard.type('bob');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(cell(page, 0, COL.owner).getByTestId('user-chip')).toHaveText([
    'ALAda Lovelace',
    'BBBob Builder',
  ]);
  await expect.poll(() => api.fieldsAt(0)[IDS.owner]).toEqual([PEOPLE.ada, PEOPLE.bob]);
});

test('barcode: the type is detected, an invalid code is refused', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, m2Types: true });
  await page.goto(GRID_URL);
  await cell(page, 0, COL.code).click();
  await page.keyboard.press('Enter');
  const box = editor(page, 'Code');
  await box.getByRole('textbox', { name: 'Code' }).fill('4006381333931');
  await expect(box.getByRole('combobox')).toContainText('Detect (EAN-13)');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, COL.code)).toHaveText('4006381333931EAN-13');
  await expect
    .poll(() => api.fieldsAt(0)[IDS.code])
    .toEqual({ text: '4006381333931', type: 'ean13' });

  await cell(page, 1, COL.code).click();
  await page.keyboard.press('Enter');
  await editor(page, 'Code').getByRole('combobox').selectOption('ean13');
  await editor(page, 'Code').getByRole('textbox', { name: 'Code' }).fill('4006381333932');
  await expect(editor(page, 'Code').getByRole('alert')).toHaveText('Not a valid EAN-13 value');
});

test('button: opens its computed URL in a new tab without an opener', async ({ page }) => {
  await mockApi(page, { rows: 3, m2Types: true });
  await page.goto(GRID_URL);
  const button = cell(page, 1, COL.open).getByRole('link', { name: 'Open page' });
  await expect(button).toHaveAttribute('href', 'https://openrows.io/f/Record%202');
  await expect(button).toHaveAttribute('target', '_blank');
  await expect(button).toHaveAttribute('rel', 'noopener noreferrer');
});

test('rich text: format with the toolbar, rendered without HTML in the record view', async ({
  page,
}) => {
  const api = await mockApi(page, { rows: 3, m2Types: true });
  await page.goto(GRID_URL);
  await cell(page, 0, COL.brief).click();
  await page.keyboard.press('Enter');
  // The WYSIWYG editor: Ctrl B toggles bold, typed Markdown links become links.
  const box = editor(page, 'Brief').getByRole('textbox', { name: 'Brief' });
  await expect(box).toBeFocused();
  await page.keyboard.press('Control+b');
  await box.pressSequentially('Launch');
  await page.keyboard.press('Control+b');
  await box.pressSequentially(' <img src=x onerror=alert(1)> [docs](https://openrows.io)');
  await expect(box.getByRole('link', { name: 'docs' })).toHaveAttribute(
    'href',
    'https://openrows.io'
  );
  await page.keyboard.press('Enter');
  await box.pressSequentially('[bad](javascript:alert(1))');
  await expect(box.locator('img, script, a[href^="javascript"]')).toHaveCount(0);
  await page.keyboard.press('Control+Enter');
  // The write is sanitized: no tag, and the unsafe link stays escaped text, never a link.
  await expect
    .poll(() => api.fieldsAt(0)[IDS.brief])
    .toBe('**Launch**  [docs](https://openrows.io)\n\n\\[bad\\](javascript:alert(1))');
  await expect(cell(page, 0, COL.brief)).toHaveText('Launch  docs [bad](javascript:alert(1))');

  await page.goto(`${GRID_URL}?record=${recordIdAt(0)}`);
  const rich = page.getByTestId('record-expand').getByTestId('rich-text');
  await expect(rich.locator('strong')).toHaveText('Launch');
  // In the edit box links are links now; no tag and no unsafe link got through.
  const docs = rich.getByRole('link', { name: 'docs' });
  await expect(docs).toHaveAttribute('href', 'https://openrows.io');
  await expect(docs).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(rich.locator('img, script, a[href^="javascript"]')).toHaveCount(0);
  await expectNoSeriousA11yIssues(page, '[data-testid="record-expand"]');
});

/** Answers every request to openrows.io, for links opened in a new tab. */
async function stubOpenrowsSite(page: Page) {
  await page
    .context()
    .route('https://openrows.io/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>OpenRows</title>' })
    );
}

test('rich text: WYSIWYG headings, lists and links, saved as Markdown', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, m2Types: true });
  await page.goto(GRID_URL);
  await cell(page, 1, COL.brief).click();
  await page.keyboard.press('Enter');
  const dialog = editor(page, 'Brief');
  const box = dialog.getByRole('textbox', { name: 'Brief' });
  await expect(box).toBeFocused();
  await dialog.getByRole('button', { name: 'Heading' }).click();
  await box.pressSequentially('Plan');
  await page.keyboard.press('Enter');
  // Markdown shortcuts work as you type, and so does the toolbar.
  await box.pressSequentially('- one');
  await page.keyboard.press('Enter');
  await box.pressSequentially('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Checklist' }).click();
  await box.pressSequentially('ship it');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await box.pressSequentially('see docs');
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  const url = dialog.getByRole('textbox', { name: 'Link URL' });
  await url.fill('javascript:alert(1)');
  await url.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('http');
  await url.fill('openrows.io/docs');
  await url.press('Enter');
  await expect(box.locator('h2')).toHaveText('Plan');
  await expect(box.locator('ul[data-type="taskList"] li > div')).toHaveText('ship it');
  const link = box.getByRole('link', { name: 'docs' });
  await expect(link).toHaveAttribute('href', 'https://openrows.io/docs');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expectNoSeriousA11yIssues(page, '[role="dialog"]');

  // The Markdown view shows what will be saved.
  await dialog.getByRole('button', { name: 'Markdown' }).click();
  const markdown = '## Plan\n\n- one\n- two\n- [ ] ship it\n\nsee [docs](https://openrows.io/docs)';
  await expect(dialog.getByRole('textbox', { name: 'Brief (Markdown)' })).toHaveValue(markdown);
  await dialog.getByRole('button', { name: 'Markdown' }).click();
  await box.focus();
  await page.keyboard.press('Control+Enter');
  await expect.poll(() => api.fieldsAt(1)[IDS.brief]).toBe(markdown);
});

test('rich text: Ctrl+click opens a link from the editor, a click from the record view', async ({
  page,
}) => {
  await stubOpenrowsSite(page);
  const api = await mockApi(page, { rows: 3, m2Types: true });
  await page.goto(GRID_URL);
  await cell(page, 2, COL.brief).click();
  await page.keyboard.press('Enter');
  const box = editor(page, 'Brief').getByRole('textbox', { name: 'Brief' });
  await box.pressSequentially('read [the guide](https://openrows.io/guide) first');
  const link = box.getByRole('link', { name: 'the guide' });
  // A plain click places the caret; Ctrl/Cmd click opens the link in a new tab.
  await link.click();
  await expect(box).toBeFocused();
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    link.click({ modifiers: ['ControlOrMeta'] }),
  ]);
  await expect(popup).toHaveURL('https://openrows.io/guide');
  // Opened without an opener (window.open with noopener).
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
  await box.focus();
  await page.keyboard.press('Control+Enter');
  await expect
    .poll(() => api.fieldsAt(2)[IDS.brief])
    .toBe('read [the guide](https://openrows.io/guide) first');

  // The record view's edit box: the link opens, a click elsewhere opens the editor.
  await page.goto(`${GRID_URL}?record=${recordIdAt(2)}`);
  const expand = page.getByTestId('record-expand');
  const recordLink = expand.getByTestId('rich-text').getByRole('link', { name: 'the guide' });
  await expect(recordLink).toHaveAttribute('target', '_blank');
  const [tab] = await Promise.all([page.waitForEvent('popup'), recordLink.click()]);
  await expect(tab).toHaveURL('https://openrows.io/guide');
  await tab.close();
  // (The editor opens in a popover over the record view.)
  await expect(editor(page, 'Brief')).toHaveCount(0);
  await expand.getByTestId('rich-text').getByText('first').click();
  await expect(editor(page, 'Brief').getByRole('textbox', { name: 'Brief' })).toBeFocused();
});

test('rich text: pasted HTML keeps only the Markdown subset', async ({ page }) => {
  const api = await mockApi(page, { rows: 3, m2Types: true });
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(GRID_URL);
  await cell(page, 0, COL.brief).click();
  await page.keyboard.press('Enter');
  const box = editor(page, 'Brief').getByRole('textbox', { name: 'Brief' });
  await expect(box).toBeFocused();
  await box.evaluate((el) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<h2 onclick="alert(1)">Title</h2><p><em>it</em> <img src=x onerror="alert(1)">' +
        '<script>alert(1)</script><a href="javascript:alert(1)">bad</a> ' +
        '<a href="https://openrows.io" onmouseover="alert(1)">good</a></p>' +
        '<iframe src="https://openrows.io"></iframe><svg onload="alert(1)"></svg>'
    );
    data.setData('text/plain', 'Title it bad good');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    );
  });
  await expect(box.locator('h2')).toHaveText('Title');
  await expect(
    box.locator(
      'script, img, iframe, svg, [onclick], [onerror], [onmouseover], a[href^="javascript"]'
    )
  ).toHaveCount(0);
  await page.keyboard.press('Control+Enter');
  await expect
    .poll(() => api.fieldsAt(0)[IDS.brief])
    .toBe('## Title\n\n*it* bad [good](https://openrows.io)');
  expect(dialogs).toEqual([]);
});
