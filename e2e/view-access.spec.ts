import AxeBuilder from '@axe-core/playwright';
import type { Browser, Page } from '@playwright/test';
import { latestMessageTo } from './auth/mailpit.js';
import { gridIds, setPlanOverrides, signInDevUser, signUp, stackApi } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// View polish against the whole Compose stack (E2E_STACK=1), where e2e/view-polish.spec.ts
// and e2e/create-view.spec.ts use a mocked API: the dev user colours a grid's rows by a single
// select (saved on the view), locks the view and makes a personal view. An editor who signs up
// through Keycloak and accepts an invitation sees the owner's colours, can't change the locked
// view (the client keeps the change to the page, the server answers 403) and never sees the
// personal view: not in the sidebar, not in the API (404).
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Choice = { id: string; name: string; color: string };
type Field = { id: string; name: string; options?: { choices?: Choice[] } };
type Table = { id: string; fields: Field[] };
type View = { id: string; name: string; personal: boolean; locked: boolean; config: unknown };

const views = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const row = (page: Page, index: number) =>
  page.getByRole('grid').locator(`[role="row"][aria-rowindex="${index + 2}"]`);

async function newPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const violations = await watchCsp(context, new URL(baseURL ?? 'http://localhost').origin);
  return { context, page: await context.newPage(), violations };
}

/** PATCHes of `viewId` that `page` sends from now on. */
function viewPatches(page: Page, viewId: string) {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().endsWith(`/api/views/${viewId}`)) sent.push(r.url());
  });
  return sent;
}

test('row colours persist; a locked view refuses an editor; a personal view stays private', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  await signInDevUser(page);
  const api = stackApi(page);
  const workspace = await api.post<{ id: string }>('/api/workspaces', {
    name: `View access ${stamp}`,
  });
  const base = await api.post<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Roadmap',
  });
  // Locked and personal views are paid features in the hosted edition CI's stack runs.
  await setPlanOverrides(page, workspace.id, {
    features: { lockedViews: true, personalViews: true },
  });
  const table = await api.post<Table>(`/api/bases/${base.id}/tables`, { name: 'Features' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  const status = table.fields.find((f) => f.name === 'Status') as Field;
  const choice = (n: string) => status.options?.choices?.find((c) => c.name === n) as Choice;
  await api.post(`/api/tables/${table.id}/records`, {
    records: [
      { fields: { [name]: 'Alpha', [status.id]: choice('Todo').id } },
      { fields: { [name]: 'Beta', [status.id]: choice('Done').id } },
      { fields: { [name]: 'Gamma' } },
    ],
  });
  await page.goto(`/b/${base.id}/${table.id}`);
  await expect(row(page, 2)).toContainText('Gamma');
  const grid = gridIds(page.url());
  const gridView = (await api.get<View>(`/api/views/${grid.viewId}`)).name;

  await test.step('row colours by a single select, kept after a reload', async () => {
    await page.getByRole('button', { name: 'Color' }).click();
    const menu = page.getByRole('dialog', { name: 'Row colors' });
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/views/${grid.viewId}`)
    );
    await menu.getByRole('radio', { name: 'By select field' }).check();
    await expect(menu.getByLabel('Color by field')).toHaveValue(status.id);
    expect((await saved).ok()).toBe(true);
    await page.keyboard.press('Escape');

    await page.reload();
    await expect(row(page, 0)).toHaveAttribute('data-row-color', choice('Todo').color);
    await expect(row(page, 1)).toHaveAttribute('data-row-color', choice('Done').color);
    await expect(row(page, 2)).not.toHaveAttribute('data-row-color');
    const view = await api.get<View>(`/api/views/${grid.viewId}`);
    expect(view.config).toMatchObject({ rowColor: { mode: 'select', fieldId: status.id } });
  });

  await test.step('the owner locks the view', async () => {
    await views(page)
      .getByRole('button', { name: `${gridView} options` })
      .click();
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/views/${grid.viewId}`)
    );
    await page.getByRole('menuitem', { name: 'Lock view' }).click();
    expect((await saved).ok()).toBe(true);
    await expect(views(page).getByLabel('Locked view')).toBeVisible();
  });

  let personal = { id: '', name: '' };
  await test.step('the owner makes a personal view, under My views', async () => {
    await views(page).getByRole('button', { name: 'Create view' }).click();
    const picker = page.getByRole('menu', { name: 'Create view' });
    // "Only me" keeps the menu open.
    await picker.getByRole('menuitemcheckbox', { name: /Only me/ }).click();
    await expect(picker.getByRole('menuitemcheckbox', { name: /Only me/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await picker.getByRole('menuitem', { name: 'Grid', exact: true }).click();
    const mine = views(page).getByRole('group', { name: 'My views' });
    await expect(mine.getByRole('link')).toHaveCount(1);
    await expect(mine.getByRole('link')).toHaveAttribute('aria-current', 'page');
    const view = await api.get<View>(`/api/views/${gridIds(page.url()).viewId}`);
    expect(view.personal).toBe(true);
    personal = { id: view.id, name: view.name };
  });

  // An editor of the workspace: invited, signs up through Keycloak and accepts.
  const invitee = {
    email: `view-access-${stamp}@openrows.test`,
    firstName: 'Eddie',
    lastName: 'Editor',
    password: 'view-access-e2e-password',
  };
  await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    email: invitee.email,
    role: 'editor',
  });
  const link = (await latestMessageTo(invitee.email)).match(
    /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/
  )?.[0];
  expect(link, 'invitation link in the email').toBeTruthy();
  const editor = await newPage(browser, baseURL);
  try {
    const b = editor.page;
    await signUp(b, invitee);
    await b.goto(new URL(link ?? '').pathname);
    await b.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(b).not.toHaveURL(/\/invite\//);
    const bApi = stackApi(b);

    await test.step("the editor sees the owner's colours and the lock", async () => {
      await b.goto(`/b/${base.id}/${table.id}/${grid.viewId}`);
      await expect(row(b, 2)).toContainText('Gamma');
      await expect(row(b, 0)).toHaveAttribute('data-row-color', choice('Todo').color);
      await expect(views(b).getByLabel('Locked view')).toBeVisible();
      // No lock or rename for an editor on a locked view.
      await views(b)
        .getByRole('button', { name: `${gridView} options` })
        .click();
      await expect(b.getByRole('menuitem', { name: /Lock view|Unlock view/ })).toHaveCount(0);
      await expect(b.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);
      await b.keyboard.press('Escape');
      const axe = await new AxeBuilder({ page: b })
        .include('nav[aria-label="Views"]')
        .include('[role="toolbar"]')
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      expect(
        axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      ).toEqual([]);
    });

    await test.step("the locked view keeps the editor's change to the page", async () => {
      const sent = viewPatches(b, grid.viewId);
      await b.getByRole('button', { name: 'Color' }).click();
      await b
        .getByRole('dialog', { name: 'Row colors' })
        .getByRole('radio', { name: 'None' })
        .check();
      await expect(row(b, 0)).not.toHaveAttribute('data-row-color');
      await b.keyboard.press('Escape');
      await b.waitForLoadState('networkidle');
      expect(sent).toEqual([]);
      await b.reload();
      await expect(row(b, 0)).toHaveAttribute('data-row-color', choice('Todo').color);
    });

    await test.step('the server refuses an editor’s change to the locked view', async () => {
      for (const body of [{ rowColor: null }, { name: 'Renamed' }, { locked: false }]) {
        const res = await bApi.raw('PATCH', `/api/views/${grid.viewId}`, body);
        expect(res.status(), JSON.stringify(body)).toBe(403);
      }
      const view = await api.get<View>(`/api/views/${grid.viewId}`);
      expect(view).toMatchObject({ name: gridView, locked: true });
      expect(view.config).toMatchObject({ rowColor: { mode: 'select', fieldId: status.id } });
    });

    await test.step("the owner's personal view is invisible to the editor", async () => {
      await expect(views(b).getByRole('link', { name: gridView })).toBeVisible();
      await expect(views(b).getByRole('link', { name: new RegExp(personal.name) })).toHaveCount(0);
      await expect(views(b).getByRole('group', { name: 'My views' })).toHaveCount(0);
      const list = await bApi.get<{ views: View[] }>(`/api/tables/${table.id}/views`);
      expect(list.views.map((v) => v.id)).not.toContain(personal.id);
      expect(list.views.map((v) => v.id)).toContain(grid.viewId);
      expect((await bApi.raw('GET', `/api/views/${personal.id}`)).status()).toBe(404);
      expect(
        (await bApi.raw('PATCH', `/api/views/${personal.id}`, { name: 'Mine now' })).status()
      ).toBe(404);
      // A deep link shows none of it either.
      await b.goto(`/b/${base.id}/${table.id}/${personal.id}`);
      await expect(views(b).getByRole('link', { name: gridView })).toBeVisible();
      await expect(views(b).getByRole('link', { name: new RegExp(personal.name) })).toHaveCount(0);
      // The owner still has it.
      const mine = await api.get<{ views: View[] }>(`/api/tables/${table.id}/views`);
      expect(mine.views.map((v) => v.id)).toContain(personal.id);
    });
    expect(editor.violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await editor.context.close();
  }
});
