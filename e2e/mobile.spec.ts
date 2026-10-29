import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi, recordIdAt } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The responsive shell on phones, against the mocked API at 360×740 and 412×915 with a
// touch screen: no horizontal page scroll on the main routes, the sidebar as a drawer (the menu
// button or a swipe from the left edge opens it, Esc/scrim/swipe/navigation close it), switching
// a view from the drawer, and editing a cell by touch through the full-screen record sheet.
// Every view type at both sizes: grid, kanban, calendar, gallery, timeline, list and form.
// E2E_SCREENSHOTS=<dir> saves screenshots.

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 412, height: 915 },
];

/**
 * Neither the document nor the page column (beside the sidebar) nor its scrolling `main` is
 * wider than the screen; the grid, the board and the toolbars scroll sideways on their own.
 */
async function expectNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const columns = Array.from(
      document.querySelectorAll('[data-testid="page"], [data-testid="page"] main')
    );
    return {
      doc: doc.scrollWidth,
      inner: window.innerWidth,
      clipped: columns.map((el) => el.scrollWidth - el.clientWidth),
    };
  });
  expect(sizes.doc).toBeLessThanOrEqual(sizes.inner);
  expect(sizes.clipped.filter((px) => px > 0)).toEqual([]);
}

async function screenshot(page: Page, name: string) {
  const dir = process.env['E2E_SCREENSHOTS'];
  if (dir) await page.screenshot({ path: `${dir}/mobile-${name}.png` });
}

const drawer = (page: Page) => page.getByRole('dialog', { name: 'Navigation' });

/** A touch from `from` to `to` (x, y), dispatched on `target` (it bubbles to the window). */
async function swipe(
  target: Locator,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  await target.dispatchEvent('touchstart', {
    touches: [{ identifier: 1, clientX: from.x, clientY: from.y }],
    changedTouches: [{ identifier: 1, clientX: from.x, clientY: from.y }],
  });
  await target.dispatchEvent('touchend', {
    touches: [],
    changedTouches: [{ identifier: 1, clientX: to.x, clientY: to.y }],
  });
}

/** The record sheet covers the whole screen, from any view. */
async function expectRecordSheet(page: Page, viewport: { width: number; height: number }) {
  const sheet = page.getByTestId('record-expand');
  await expect(sheet).toBeVisible();
  expect(await sheet.boundingBox()).toMatchObject({
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  });
  await sheet.getByRole('button', { name: 'Close' }).tap();
  await expect(sheet).toBeHidden();
}
const openDrawer = async (page: Page) => {
  await page.getByRole('button', { name: 'Open navigation' }).tap();
  await expect(drawer(page)).toBeVisible();
};

/** Members and invitations of the mock workspace, for the members page. */
async function mockMembers(page: Page) {
  await page.route(`**/api/workspaces/${IDS.workspace}/members`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        members: [
          {
            userId: '00000007-0000-4000-8000-000000000001',
            name: 'Ada Lovelace',
            email: 'ada@example.test',
            avatarUrl: null,
            role: 'owner',
            joinedAt: '2026-10-25T10:00:00.000Z',
          },
          {
            userId: '00000007-0000-4000-8000-000000000003',
            name: 'Grace Brewster Murray Hopper',
            email: 'grace.brewster.murray.hopper@a-rather-long-domain.example.test',
            avatarUrl: null,
            role: 'editor',
            joinedAt: '2026-10-25T10:00:00.000Z',
          },
        ],
      }),
    })
  );
  await page.route(`**/api/workspaces/${IDS.workspace}/invitations`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ invitations: [] }) })
  );
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    const size = `${viewport.width}`;

    test('home fits the screen and the sidebar is a drawer', async ({ page }) => {
      await mockApi(page, { rows: 5 });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Ada');
      await expect(page.getByRole('link', { name: /Product Roadmap/ })).toBeVisible();
      // The sidebar is hidden by default.
      await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      // Cards span the content column (one column).
      const card = await page.getByRole('button', { name: /Start from scratch/ }).boundingBox();
      expect(card?.width ?? 0).toBeGreaterThan(viewport.width - 40);
      // No keyboard shortcut hints on a touch screen.
      await expect(page.getByRole('button', { name: 'Search bases' }).locator('kbd')).toBeHidden();
      await expect(page.getByText('press Ctrl K anytime')).toBeHidden();
      await screenshot(page, `${size}-home`);

      // Esc closes the drawer, and focus is trapped inside it while open.
      await openDrawer(page);
      await expect(drawer(page).getByRole('link', { name: 'Home' })).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
        .toBe(true);
      // After the slide-in.
      await expect.poll(() => drawer(page).evaluate((el) => el.getAnimations().length)).toBe(0);
      await screenshot(page, `${size}-drawer`);
      await page.keyboard.press('Escape');
      await expect(drawer(page)).toBeHidden();
      await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();

      // A tap on the scrim closes it.
      await openDrawer(page);
      await page.touchscreen.tap(viewport.width - 16, viewport.height / 2);
      await expect(drawer(page)).toBeHidden();

      // So does a swipe to the left.
      await openDrawer(page);
      const box = await drawer(page).boundingBox();
      const y = (box?.y ?? 0) + 300;
      await swipe(drawer(page), { x: 220, y }, { x: 60, y: y + 10 });
      await expect(drawer(page)).toBeHidden();

      // A swipe to the right from the left edge opens it; one from the middle doesn't.
      const main = page.locator('main').first();
      await swipe(main, { x: 120, y }, { x: 300, y: y + 5 });
      await expect(drawer(page)).toBeHidden();
      await swipe(main, { x: 6, y }, { x: 180, y: y + 5 });
      await expect(drawer(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer(page)).toBeHidden();

      // Navigating closes it: Settings, which fits the screen too.
      await openDrawer(page);
      await drawer(page).getByRole('link', { name: 'Settings' }).tap();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(drawer(page)).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await screenshot(page, `${size}-settings`);
    });

    test('home has no serious accessibility violations', async ({ page }) => {
      await mockApi(page, { rows: 5 });
      await page.goto('/');
      await expect(page.getByRole('link', { name: /Product Roadmap/ })).toBeVisible();
      // Lighthouse's accessibility score is axe-based; WCAG 2.2 adds the target size rule.
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = results.violations.filter((v) =>
        ['serious', 'critical'].includes(v.impact ?? '')
      );
      expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target}`))).toEqual([]);
    });

    test('the command palette is a full-screen sheet', async ({ page }) => {
      await mockApi(page, { rows: 5 });
      await page.goto('/');
      await page.getByRole('button', { name: 'Search bases' }).tap();
      const palette = page.getByRole('dialog', { name: 'Search and commands' });
      await expect(palette).toBeVisible();
      const box = await palette.boundingBox();
      expect(box).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
      await screenshot(page, `${size}-palette`);
      await palette.getByRole('button', { name: 'Close' }).tap();
      await expect(palette).toBeHidden();
    });

    test('the members page fits the screen', async ({ page }) => {
      await mockApi(page, { rows: 5 });
      await mockMembers(page);
      await page.goto(`/w/${IDS.workspace}/members`);
      await expect(page.getByText('Grace Brewster Murray Hopper')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await screenshot(page, `${size}-members`);
    });

    test('grid: switch the view from the drawer, edit a cell through the record sheet', async ({
      page,
    }) => {
      const api = await mockApi(page, { rows: 30, secondView: true });
      await page.goto(GRID_URL);
      const grid = page.getByTestId('grid');
      const cell = (row: number, col: number) => grid.locator(`[data-cell="${row}:${col}"]`);
      await expect(cell(0, 0)).toHaveText('Record 1');
      await expectNoHorizontalOverflow(page);
      // The grid scrolls sideways inside itself; rows and the expand target are tap-sized.
      expect(
        await grid.evaluate((el) => el.scrollWidth > el.clientWidth && el.clientWidth > 0)
      ).toBe(true);
      const row = await cell(0, 0).boundingBox();
      expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
      // The frozen primary column leaves room for the others.
      expect((row?.x ?? 0) + (row?.width ?? 0)).toBeLessThanOrEqual(viewport.width / 2 + 20);
      const expand = await page
        .getByRole('button', { name: 'Expand record 1', exact: true })
        .boundingBox();
      expect(expand?.height ?? 0).toBeGreaterThanOrEqual(40);
      await screenshot(page, `${size}-grid`);

      // Switch the view in the drawer; the drawer closes on navigation.
      await openDrawer(page);
      await drawer(page).getByRole('link', { name: 'Phone view' }).tap();
      await expect(page).toHaveURL(new RegExp(`/${IDS.view2}$`));
      await expect(drawer(page)).toBeHidden();
      const title = page.getByRole('heading', { name: 'Phone view' });
      await expect(title).toBeVisible();
      // The base's pages sit in one "More" menu so the view's name keeps its room.
      expect((await title.boundingBox())?.width ?? 0).toBeGreaterThan(40);
      await page.getByRole('button', { name: 'More', exact: true }).tap();
      await expect(page.getByRole('menuitem', { name: 'Interfaces' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden();

      // Tap selects a cell; a second tap opens the record sheet on that field's editor.
      await cell(1, 0).tap();
      await expect(cell(1, 0)).toBeFocused();
      await expect(page.getByTestId('record-expand')).toHaveCount(0);
      await cell(1, 0).tap();
      const sheet = page.getByTestId('record-expand');
      await expect(sheet).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`\\?record=${recordIdAt(1)}$`));
      expect(await sheet.boundingBox()).toMatchObject({
        x: 0,
        y: 0,
        width: viewport.width,
        height: viewport.height,
      });
      const name = sheet.getByRole('textbox', { name: 'Name' });
      await expect(name).toBeFocused();
      await name.fill('Edited on a phone');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Edited on a phone' })).toBeVisible();
      await screenshot(page, `${size}-record`);

      // Another field, by tapping it in the sheet.
      await sheet.getByRole('button', { name: 'Estimate' }).tap();
      await sheet.getByRole('textbox', { name: 'Estimate' }).fill('7');
      await page.keyboard.press('Enter');
      await expect(sheet.getByRole('button', { name: 'Estimate' })).toHaveText('7');

      await sheet.getByRole('button', { name: 'Close' }).tap();
      await expect(sheet).toBeHidden();
      await expect(cell(1, 0)).toHaveText('Edited on a phone');
      const patch = `PATCH /api/tables/${IDS.table}/records/${recordIdAt(1)}`;
      expect(api.calls.filter((c) => c === patch)).toHaveLength(2);
      expect(api.fieldsAt(1)[IDS.name]).toBe('Edited on a phone');
    });

    test('kanban and calendar views have no page overflow', async ({ page }) => {
      await mockApi(page, { rows: 30, kanban: true });
      await page.goto(GRID_URL);
      const board = page.getByRole('region', { name: 'Board' });
      await expect(board.getByTestId('stack-count').first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      // The stacks scroll sideways inside the board.
      expect(await board.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await screenshot(page, `${size}-kanban`);

      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await mockApi(page, { rows: 30, calendar: true });
      await page.goto(GRID_URL);
      await expect(page.getByRole('toolbar', { name: 'View' })).toBeVisible();
      await expect(page.getByRole('region', { name: /^Calendar/ })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await screenshot(page, `${size}-calendar`);
    });

    test('gallery: one card per row across the screen, opened as a sheet', async ({ page }) => {
      await mockApi(page, { rows: 30, gallery: true });
      await page.goto(GRID_URL);
      const cards = page.getByRole('list', { name: 'Cards' }).getByRole('listitem');
      await expect(cards.first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()];
      // 16 px padding on each side; the second card sits under the first.
      expect(a?.width ?? 0).toBe(viewport.width - 32);
      expect(b?.x).toBe(a?.x);
      expect(b?.y ?? 0).toBeGreaterThan((a?.y ?? 0) + (a?.height ?? 0));
      await screenshot(page, `${size}-gallery`);
      await cards.first().tap();
      await expectRecordSheet(page, viewport);
    });

    test('timeline: narrow names, the bars get the screen', async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-03-18T12:00:00'));
      await mockApi(page, { rows: 30, timeline: true });
      await page.goto(GRID_URL);
      const canvas = page.getByRole('region', { name: 'Timeline' });
      const bar = page.getByRole('button', { name: /^Record 13, / });
      await expect(bar).toBeVisible();
      await expectNoHorizontalOverflow(page);
      // The names column is 120 px; the timeline scrolls sideways inside its region.
      const name = canvas.getByRole('button', { name: 'Record 13', exact: true });
      expect((await name.boundingBox())?.width).toBe(120);
      expect(await canvas.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      await screenshot(page, `${size}-timeline`);
      await name.tap();
      await expectRecordSheet(page, viewport);
    });

    test('list: titles get the width, rows are tap-sized', async ({ page }) => {
      await mockApi(page, { rows: 30, list: true });
      await page.goto(GRID_URL);
      const row = page.getByRole('treeitem', { name: 'Record 1', exact: true });
      await expect(row).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      // Only the title and the child count: no field columns squeezing it.
      await expect(row).toHaveText(/^Record 1\s*3$/);
      await screenshot(page, `${size}-list`);
      await page.getByRole('treeitem', { name: 'Record 13', exact: true }).tap();
      await expectRecordSheet(page, viewport);
    });

    test('form: the builder and the preview stack in one column', async ({ page }) => {
      await mockApi(page, { rows: 5, form: true });
      await page.goto(GRID_URL);
      const builder = page.getByRole('complementary', { name: 'Form builder' });
      const preview = page.getByRole('region', { name: 'Form preview' });
      await expect(preview.getByRole('heading', { name: 'Feature request' })).toBeVisible();
      await expect(builder).toBeVisible();
      await expectNoHorizontalOverflow(page);
      const [b, p] = [await builder.boundingBox(), await preview.boundingBox()];
      expect(b?.width ?? 0).toBeGreaterThan(viewport.width - 40);
      expect(p?.y ?? 0).toBeGreaterThanOrEqual((b?.y ?? 0) + (b?.height ?? 0) - 1);
      await screenshot(page, `${size}-form`);
      // Adding a field by touch.
      await builder.getByRole('button', { name: 'Add Notes' }).tap();
      await expect(preview.getByTestId('form-preview-field')).toHaveCount(3);
    });
  });
}

// The collapsed sidebar (768–1023 px) names its buttons on hover and focus.
test.describe('rail', () => {
  test.use({ viewport: { width: 900, height: 700 } });

  test('has tooltips', async ({ page }) => {
    await mockApi(page, { rows: 5 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Ada');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    const rail = page.getByRole('navigation', { name: 'Sidebar' });
    await rail.getByRole('link', { name: 'Home' }).hover();
    await expect(page.getByRole('tooltip', { name: 'Home' })).toBeVisible();
    await rail.getByRole('button', { name: 'Search and commands' }).focus();
    await expect(page.getByRole('tooltip', { name: 'Search and commands' })).toBeVisible();
  });
});
