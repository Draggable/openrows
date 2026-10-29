import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { latestMessageTo } from './auth/mailpit.js';
import { signInDevUser, signUp, stackApi } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Interfaces against the whole Compose stack (E2E_STACK=1): the dev user builds a record
// review page in the designer (text, a viewer filter, an editable field, a button dragged into
// place), publishes it and uses it; a second page stays unpublished. An editor who signs up
// through Keycloak and accepts an invitation sees the published page only, without the
// designer, and filters and reviews its records.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Field = { id: string; name: string; options?: { choices?: { id: string; name: string }[] } };
type Table = { id: string; fields: Field[] };
type Page_ = { id: string; draft: { elements: { id: string; type: string; x: number }[] } | null };
type List = { interfaces: { id: string; name: string; pages: (Page_ & { name: string })[] }[] };

const canvas = (page: Page) => page.getByTestId('interface-canvas');
const records = (page: Page) => page.getByRole('region', { name: 'Tasks records' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Page settings' });
const draftSaved = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /\/interfaces\/[^/]+\/pages\/[^/]+$/.test(r.url())
  );

async function seriousViolations(page: Page) {
  const axe = await new AxeBuilder({ page })
    .include('main')
    .include('nav[aria-label="Interfaces"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  return axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

test('build and publish a record review page; unpublished pages stay hidden', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  await signInDevUser(page);
  const api = stackApi(page);
  const workspace = await api.post<{ id: string }>('/api/workspaces', {
    name: `Interfaces ${stamp}`,
  });
  const base = await api.post<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Ops',
  });
  const table = await api.post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  const status = table.fields.find((f) => f.name === 'Status') as Field;
  const choice = (n: string) => status.options?.choices?.find((c) => c.name === n)?.id;
  await api.post(`/api/tables/${table.id}/records`, {
    records: [
      { fields: { [name]: 'Alpha', [status.id]: choice('Todo') } },
      { fields: { [name]: 'Beta', [status.id]: choice('Done') } },
      { fields: { [name]: 'Gamma', [status.id]: choice('In progress') } },
    ],
  });

  await test.step('create an interface with a record review page from the base', async () => {
    await page.goto(`/b/${base.id}`);
    await page.getByRole('link', { name: 'Interfaces' }).click();
    await expect(page).toHaveURL(new RegExp(`/b/${base.id}/interfaces`));
    await page.getByRole('main').getByRole('button', { name: 'New interface' }).click();
    const dialog = page.getByRole('dialog', { name: 'New interface' });
    await dialog.getByLabel('Interface name').fill('Ops desk');
    await dialog.getByLabel('Page name').fill('Review');
    await expect(dialog.getByRole('radio', { name: /Record review/ })).toBeChecked();
    await dialog.getByLabel('Table', { exact: true }).selectOption({ label: 'Tasks' });
    await dialog.getByRole('button', { name: 'Create page' }).click();
    await expect(page).toHaveURL(/edit=true/);
    await expect(page.getByRole('status').filter({ hasText: 'Not published' })).toBeVisible();
  });

  await test.step('arrange text, a filter, an editable field and a button', async () => {
    const add = (label: string) =>
      panel(page)
        .getByRole('button', { name: `Add ${label.toLowerCase()}` })
        .click();

    await add('Text');
    let saved = draftSaved(page);
    await panel(page).getByLabel('Text (Markdown)').fill('## Task review');
    await saved;
    await panel(page).getByRole('button', { name: 'Done' }).click();

    await add('Filter');
    saved = draftSaved(page);
    await panel(page).getByLabel('Field', { exact: true }).selectOption({ label: 'Status' });
    await saved;
    await panel(page).getByRole('button', { name: 'Done' }).click();

    await add('Field');
    saved = draftSaved(page);
    await panel(page).getByLabel('Field', { exact: true }).selectOption({ label: 'Status' });
    await panel(page).getByLabel('Editable (by editors and up)').check();
    await saved;
    await panel(page).getByRole('button', { name: 'Done' }).click();

    await add('Button');
    saved = draftSaved(page);
    await panel(page).getByLabel('Label', { exact: true }).fill('Docs');
    await saved;
    await panel(page).getByRole('button', { name: 'Done' }).click();

    // Drag the button two columns right (the grid has 12).
    const button = canvas(page).getByRole('button', { name: 'Button element' });
    const grid = await canvas(page).boundingBox();
    const box = await button.boundingBox();
    if (!grid || !box) throw new Error('no canvas');
    const column = (grid.width - 16) / 12;
    saved = draftSaved(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + column, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 + column * 2, box.y + box.height / 2, {
      steps: 4,
    });
    await page.mouse.up();
    await saved;
    // And the field element one column right from the keyboard.
    const fieldEl = canvas(page).getByRole('button', { name: 'Field element' });
    await fieldEl.focus();
    saved = draftSaved(page);
    await page.keyboard.press('Alt+ArrowRight');
    await saved;

    const list = await api.get<List>(`/api/bases/${base.id}/interfaces`);
    const draft = list.interfaces[0]?.pages[0]?.draft;
    expect(draft?.elements.map((e) => [e.type, e.x])).toEqual([
      ['text', 0],
      ['filter', 0],
      ['field', 1],
      ['button', 2],
    ]);
    await expect(page.getByRole('status').filter({ hasText: 'Not published' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  await test.step('publish, preview and use the page', async () => {
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status').filter({ hasText: /^Published$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page).not.toHaveURL(/edit=true/);
    await expect(page.getByRole('heading', { name: 'Task review' })).toBeVisible();
    await expect(records(page).getByRole('button')).toHaveCount(3);
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Done' });
    await expect(records(page).getByRole('button')).toHaveCount(1);
    await expect(records(page)).toContainText('Beta');
    const selected = page.getByRole('region', { name: 'Selected record' });
    await expect(selected.getByRole('heading', { name: 'Beta' })).toBeVisible();
    await expect(selected).toContainText('Done');
    await expect(selected.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      'https://openrows.io'
    );
    expect(await seriousViolations(page)).toEqual([]);
  });

  // A second page that is never published.
  const list = await api.get<List>(`/api/bases/${base.id}/interfaces`);
  const iface = list.interfaces[0];
  if (!iface) throw new Error('no interface');
  await api.post(`/api/bases/${base.id}/interfaces/${iface.id}/pages`, {
    name: 'Hidden draft',
    layout: 'recordList',
    tableId: table.id,
  });
  await page.reload();
  await expect(
    page.getByRole('navigation', { name: 'Interfaces' }).getByRole('link', { name: /Hidden draft/ })
  ).toBeVisible();

  const invitee = {
    email: `interfaces-${stamp}@openrows.test`,
    firstName: 'Ida',
    lastName: 'Editor',
    password: 'interfaces-e2e-password',
  };
  await api.post(`/api/workspaces/${workspace.id}/invitations`, {
    email: invitee.email,
    role: 'editor',
  });
  const link = (await latestMessageTo(invitee.email)).match(
    /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/
  )?.[0];
  expect(link, 'invitation link in the email').toBeTruthy();
  const context = await browser.newContext({ baseURL });
  const violations = await watchCsp(context, new URL(baseURL ?? 'http://localhost').origin);
  try {
    const b = await context.newPage();
    await signUp(b, invitee);
    await b.goto(new URL(link ?? '').pathname);
    await b.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(b).not.toHaveURL(/\/invite\//);

    await test.step('an editor sees the published page only, without the designer', async () => {
      await b.goto(`/b/${base.id}/interfaces`);
      const nav = b.getByRole('navigation', { name: 'Interfaces' });
      await expect(nav.getByRole('link', { name: 'Review' })).toBeVisible();
      await expect(nav.getByRole('link', { name: /Hidden draft/ })).toHaveCount(0);
      await expect(b.getByRole('button', { name: 'Publish' })).toHaveCount(0);
      await expect(b.getByRole('button', { name: 'Edit' })).toHaveCount(0);
      await expect(b.getByRole('heading', { name: 'Task review' })).toBeVisible();
      await b.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Todo' });
      await expect(records(b).getByRole('button')).toHaveCount(1);
      await expect(records(b)).toContainText('Alpha');
      // The unpublished page is a 404 to them.
      const hidden = (
        await api.get<List>(`/api/bases/${base.id}/interfaces`)
      ).interfaces[0]?.pages.find((p) => p.name === 'Hidden draft');
      const res = await b.request.get(
        `/api/bases/${base.id}/interfaces/${iface.id}/pages/${hidden?.id}`
      );
      expect(res.status()).toBe(404);
      expect(await seriousViolations(b)).toEqual([]);
    });
  } finally {
    await context.close();
  }
  expect(violations).toEqual([]);
});

// Dashboards: numbers and charts aggregated by the server, narrowed by a filter element,
// and refreshed live (debounced) when the table's records change.
test('a dashboard renders server-side aggregates and follows live changes', async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await signInDevUser(page);
  const api = stackApi(page);
  const workspace = await api.post<{ id: string }>('/api/workspaces', {
    name: `Dashboards ${stamp}`,
  });
  const base = await api.post<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Ops',
  });
  const table = await api.post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  const status = table.fields.find((f) => f.name === 'Status') as Field;
  const choice = (n: string) => status.options?.choices?.find((c) => c.name === n)?.id;
  await api.post(`/api/tables/${table.id}/records`, {
    records: [
      { fields: { [name]: 'Alpha', [status.id]: choice('Todo') } },
      { fields: { [name]: 'Beta', [status.id]: choice('Done') } },
      { fields: { [name]: 'Gamma', [status.id]: choice('Done') } },
    ],
  });
  const iface = await api.post<{ id: string }>(`/api/bases/${base.id}/interfaces`, {
    name: 'Ops board',
  });
  const created = await api.post<{ id: string }>(
    `/api/bases/${base.id}/interfaces/${iface.id}/pages`,
    { name: 'Overview', layout: 'dashboard', tableId: table.id }
  );
  const path = `/api/bases/${base.id}/interfaces/${iface.id}/pages/${created.id}`;
  await api.patch(path, {
    draft: {
      layout: 'dashboard',
      tableId: table.id,
      elements: [
        { id: 'status', type: 'filter', x: 0, y: 0, w: 4, h: 2, fieldId: status.id },
        { id: 'tasks', type: 'number', x: 0, y: 2, w: 3, h: 2, label: 'Tasks', tableId: table.id },
        {
          id: 'chart',
          type: 'chart',
          x: 3,
          y: 2,
          w: 6,
          h: 6,
          tableId: table.id,
          chart: 'bar',
          groupFieldId: status.id,
        },
      ],
    },
  });
  await api.post(`${path}/publish`, {});

  await page.goto(`/b/${base.id}/interfaces?p=${created.id}`);
  const dashboard = page.getByRole('region', { name: 'Dashboard' });
  const tasks = dashboard.getByTestId('number-value');
  await expect(tasks).toHaveText('3');
  await expect(dashboard.getByTestId('chart-bar')).toHaveCount(2);
  await expect(dashboard.getByRole('table', { name: 'Records by Status' })).toContainText('Done2');
  expect(await seriousViolations(page)).toEqual([]);

  // A record added elsewhere shows up without a reload.
  await api.post(`/api/tables/${table.id}/records`, {
    fields: { [name]: 'Delta', [status.id]: choice('In progress') },
  });
  await expect(tasks).toHaveText('4', { timeout: 15_000 });
  await expect(dashboard.getByTestId('chart-bar')).toHaveCount(3);

  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Done' });
  await expect(tasks).toHaveText('2');
  await expect(dashboard.getByTestId('chart-bar')).toHaveCount(1);
});
