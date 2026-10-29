import type { Locator, Page } from '@playwright/test';
import { gridIds, signInDevUser, stackApi } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// The kanban, calendar, gallery, timeline and list views against the whole
// Compose stack (E2E_STACK=1), where e2e/kanban, calendar, gallery, timeline and list.spec.ts
// use a mocked API: each view is made from the sidebar's Create view picker and configured
// from its own screen (stack field, date fields, cover field, dependency field, parent link), so
// the real server accepts the layout; a card, an event and a bar moved by drag stay moved after
// a reload. The calendar and the timeline fix the browser's clock on March 18, 2026.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Field = { id: string; name: string; options?: { choices?: { id: string; name: string }[] } };
type Table = { id: string; fields: Field[] };
type Rec = { id: string; fields: Record<string, unknown> };
type Api = ReturnType<typeof stackApi>;

/** Signs in and makes a workspace, a base and a table (Name, Notes, Status: Todo, …). */
async function setup(page: Page, area: string) {
  await signInDevUser(page);
  const api = stackApi(page);
  const workspace = await api.post<{ id: string }>('/api/workspaces', {
    name: `Views ${area} ${Date.now()}`,
  });
  const base = await api.post<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: area,
  });
  const table = await api.post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const field = (name: string) => table.fields.find((f) => f.name === name) as Field;
  const addField = (body: Record<string, unknown>) =>
    api.post<Field>(`/api/tables/${table.id}/fields`, body);
  const addRecords = async (records: Record<string, unknown>[]) =>
    (
      await api.post<{ records: Rec[] }>(`/api/tables/${table.id}/records`, {
        records: records.map((fields) => ({ fields })),
      })
    ).records;
  return { api, base, table, name: field('Name').id, field, addField, addRecords };
}

const views = (page: Page) => page.getByRole('navigation', { name: 'Views' });

/** Creates a view of `type` (its picker label) from the sidebar; answers its id. */
async function createView(page: Page, type: string) {
  await views(page).getByRole('button', { name: 'Create view' }).click();
  await page
    .getByRole('menu', { name: 'Create view' })
    .getByRole('menuitem', { name: type })
    .click();
  await expect(views(page).getByRole('link', { name: type })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(page).toHaveURL(/\/b\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}/);
  return gridIds(page.url()).viewId;
}

/** Runs `act` and waits for the PATCH of the view it causes. */
async function savesView(page: Page, viewId: string, act: () => Promise<unknown>) {
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/views/${viewId}`)
  );
  await act();
  expect((await saved).ok()).toBe(true);
}

/** Runs `act` and waits for the PATCH of one record of the table it causes. */
async function savesRecord(page: Page, tableId: string, act: () => Promise<unknown>) {
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes(`/api/tables/${tableId}/records/`)
  );
  await act();
  expect((await saved).ok()).toBe(true);
}

async function recordOf(api: Api, tableId: string, id: string) {
  const { records } = await api.get<{ records: Rec[] }>(`/api/tables/${tableId}/records`);
  return records.find((r) => r.id === id)?.fields ?? {};
}

/** Drags `handle` sideways by `dx` px with the mouse (pointer events, as the timeline uses). */
async function dragBy(page: Page, handle: Locator, dx: number) {
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error('no box');
  const x = box.x + Math.min(box.width / 2, 20);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

test('kanban: stack by a select, drag a card to another stack, kept after a reload', async ({
  page,
}) => {
  const t = await setup(page, 'Kanban');
  const status = t.field('Status');
  const choice = (name: string) => status.options?.choices?.find((c) => c.name === name)?.id;
  const [alpha] = await t.addRecords([
    { [t.name]: 'Alpha', [status.id]: choice('Todo') },
    { [t.name]: 'Beta', [status.id]: choice('Todo') },
    { [t.name]: 'Gamma', [status.id]: choice('In progress') },
  ]);
  await page.goto(`/b/${t.base.id}/${t.table.id}`);
  const viewId = await createView(page, 'Kanban');

  const stack = (name: string) => page.getByRole('list', { name, exact: true });
  const titles = (name: string) =>
    stack(name)
      .getByRole('article')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  await expect(page.getByRole('heading', { name: 'Stack records by a field' })).toBeVisible();
  await savesView(page, viewId, () =>
    page.getByRole('button', { name: 'Stack by Status' }).click()
  );
  await expect(page.getByRole('button', { name: 'Stacked by: Status' })).toBeVisible();
  await expect.poll(() => titles('Todo')).toEqual(['Alpha', 'Beta']);
  await expect.poll(() => titles('In progress')).toEqual(['Gamma']);

  const card = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('article', { name: 'Alpha', exact: true }) });
  const moved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/api/views/${viewId}/order`)
  );
  await savesRecord(page, t.table.id, () =>
    card.dragTo(stack('In progress'), { targetPosition: { x: 120, y: 4 } })
  );
  expect((await moved).ok()).toBe(true);
  await expect.poll(() => titles('In progress')).toEqual(['Alpha', 'Gamma']);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Stacked by: Status' })).toBeVisible();
  await expect.poll(() => titles('In progress')).toEqual(['Alpha', 'Gamma']);
  await expect.poll(() => titles('Todo')).toEqual(['Beta']);
  expect((await recordOf(t.api, t.table.id, alpha?.id ?? ''))[status.id]).toBe(
    choice('In progress')
  );
});

test('calendar: start and end fields, drag an event to another day, kept after a reload', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-03-18T12:00:00'));
  const t = await setup(page, 'Calendar');
  const start = await t.addField({ name: 'Start', type: 'date' });
  const end = await t.addField({ name: 'End', type: 'date' });
  const [kickoff] = await t.addRecords([
    { [t.name]: 'Kickoff', [start.id]: '2026-03-02' },
    { [t.name]: 'Sprint', [start.id]: '2026-03-09', [end.id]: '2026-03-11' },
  ]);
  await page.goto(`/b/${t.base.id}/${t.table.id}`);
  const viewId = await createView(page, 'Calendar');

  const event = (title: string) => page.getByRole('button', { name: new RegExp(`^${title}, `) });
  await expect(page.getByRole('heading', { name: 'Choose a date field' })).toBeVisible();
  await savesView(page, viewId, () =>
    page.getByRole('button', { name: 'Start', exact: true }).click()
  );
  await expect(page.getByRole('heading', { name: 'March 2026' })).toBeVisible();
  await page.getByRole('button', { name: 'Date fields (1)' }).click();
  await savesView(page, viewId, () =>
    page.getByLabel('End field 1').selectOption({ label: 'End' })
  );
  await page.keyboard.press('Escape');
  await expect(event('Sprint')).toHaveAccessibleName(
    'Sprint, Monday, March 9, 2026 to Wednesday, March 11, 2026'
  );

  await savesRecord(page, t.table.id, () =>
    event('Kickoff').dragTo(page.locator('[data-day="2026-03-10"]'), {
      targetPosition: { x: 40, y: 110 },
    })
  );
  await expect(event('Kickoff')).toHaveAccessibleName('Kickoff, Tuesday, March 10, 2026');

  await page.reload();
  await expect(event('Kickoff')).toHaveAccessibleName('Kickoff, Tuesday, March 10, 2026');
  await expect(event('Sprint')).toHaveAccessibleName(
    'Sprint, Monday, March 9, 2026 to Wednesday, March 11, 2026'
  );
  expect((await recordOf(t.api, t.table.id, kickoff?.id ?? ''))[start.id]).toBe('2026-03-10');
});

// The smallest PNG: one transparent pixel.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

test('gallery: a cover field and the card size, kept after a reload', async ({ page }) => {
  const t = await setup(page, 'Gallery');
  const mockup = await t.addField({ name: 'Mockup', type: 'attachment' });
  const [alpha] = await t.addRecords([{ [t.name]: 'Alpha' }, { [t.name]: 'Beta' }]);
  // An image in Alpha's Mockup: announced, PUT to the presigned URL (the stack's S3), confirmed.
  const { attachment, upload } = await t.api.post<{
    attachment: { id: string };
    upload: { url: string; headers: Record<string, string> };
  }>(`/api/tables/${t.table.id}/attachments`, {
    fieldId: mockup.id,
    filename: 'cover.png',
    type: 'image/png',
    size: PIXEL.length,
  });
  const put = await page.request.put(upload.url, { data: PIXEL, headers: upload.headers });
  expect(put.ok(), `PUT to storage: ${put.status()}`).toBe(true);
  const confirmed = await t.api.post<unknown>(
    `/api/tables/${t.table.id}/attachments/${attachment.id}/confirm`,
    {}
  );
  await t.api.patch(`/api/tables/${t.table.id}/records/${alpha?.id}`, {
    fields: { [mockup.id]: [confirmed] },
  });

  await page.goto(`/b/${t.base.id}/${t.table.id}`);
  const viewId = await createView(page, 'Gallery');
  const cards = page.getByRole('list', { name: 'Cards' });
  await expect(cards.getByRole('article', { name: 'Alpha', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Customize cards' }).click();
  const settings = page.getByRole('dialog', { name: 'Customize cards' });
  await savesView(page, viewId, () =>
    settings.getByLabel('Cover image').selectOption({ label: 'Mockup' })
  );
  await savesView(page, viewId, () => settings.getByRole('button', { name: 'Large' }).click());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('img', { name: 'cover.png' })).toBeAttached();

  await page.reload();
  await expect(cards.getByRole('article', { name: 'Beta', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'cover.png' })).toBeAttached();
  await page.getByRole('button', { name: 'Customize cards' }).click();
  await expect(settings.getByLabel('Cover image')).toHaveValue(mockup.id);
  await expect(settings.getByRole('button', { name: 'Large' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('timeline: dates and a dependency field, drag a bar, kept after a reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.clock.setFixedTime(new Date('2026-03-18T12:00:00'));
  const t = await setup(page, 'Timeline');
  const start = await t.addField({ name: 'Start', type: 'date' });
  const end = await t.addField({ name: 'End', type: 'date' });
  const dependsOn = await t.addField({
    name: 'Depends on',
    type: 'link',
    options: { linkedTableId: t.table.id },
  });
  const [design] = await t.addRecords([
    { [t.name]: 'Design', [start.id]: '2026-03-16', [end.id]: '2026-03-17' },
  ]);
  const [build] = await t.addRecords([
    {
      [t.name]: 'Build',
      [start.id]: '2026-03-18',
      [end.id]: '2026-03-20',
      [dependsOn.id]: [design?.id],
    },
  ]);
  await page.goto(`/b/${t.base.id}/${t.table.id}`);
  const viewId = await createView(page, 'Timeline');

  const bar = (title: string) => page.getByRole('button', { name: new RegExp(`^${title}, `) });
  const arrow = page.locator(
    `[data-testid="dependency"][data-from="${design?.id}"][data-to="${build?.id}"]`
  );
  await savesView(page, viewId, () => page.getByRole('button', { name: 'Start on Start' }).click());
  await page.getByRole('button', { name: 'Timeline settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Timeline settings' });
  await savesView(page, viewId, () =>
    settings.getByLabel('End date').selectOption({ label: 'End' })
  );
  await savesView(page, viewId, () =>
    settings.getByLabel('Dependencies (Gantt)').selectOption({ label: 'Depends on' })
  );
  await page.keyboard.press('Escape');
  await expect(bar('Build')).toHaveAccessibleName(
    'Build, Wednesday, March 18, 2026 to Friday, March 20, 2026'
  );
  await expect(arrow).toHaveAttribute('data-conflict', 'false');

  // A day is 44 px in the day zoom: Build moves two days later and keeps its length.
  await savesView(page, viewId, () =>
    page.getByRole('button', { name: 'Day', exact: true }).click()
  );
  await savesRecord(page, t.table.id, () => dragBy(page, bar('Build'), 44 * 2));
  await expect(bar('Build')).toHaveAccessibleName(
    'Build, Friday, March 20, 2026 to Sunday, March 22, 2026'
  );

  await page.reload();
  await expect(page.getByRole('button', { name: 'Day', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(bar('Build')).toHaveAccessibleName(
    'Build, Friday, March 20, 2026 to Sunday, March 22, 2026'
  );
  await expect(arrow).toBeAttached();
  const saved = await recordOf(t.api, t.table.id, build?.id ?? '');
  expect([saved[start.id], saved[end.id]]).toEqual(['2026-03-20', '2026-03-22']);
});

test('list: nest records under a parent link, kept after a reload', async ({ page }) => {
  const t = await setup(page, 'List');
  const parent = await t.addField({
    name: 'Parent',
    type: 'link',
    options: { linkedTableId: t.table.id },
  });
  const [epic] = await t.addRecords([{ [t.name]: 'Epic' }]);
  const [story] = await t.addRecords([{ [t.name]: 'Story', [parent.id]: [epic?.id] }]);
  await t.addRecords([{ [t.name]: 'Task', [parent.id]: [story?.id] }]);
  await page.goto(`/b/${t.base.id}/${t.table.id}`);
  const viewId = await createView(page, 'List');

  const item = (title: string) => page.getByRole('treeitem', { name: title, exact: true });
  await expect(item('Task')).toHaveAttribute('aria-level', '1');
  await page.getByRole('button', { name: 'Customize list' }).click();
  await savesView(page, viewId, () =>
    page
      .getByRole('dialog', { name: 'Customize list' })
      .getByLabel('Nest under')
      .selectOption({ label: 'Parent' })
  );
  await page.keyboard.press('Escape');
  await expect(item('Story')).toHaveAttribute('aria-level', '2');
  await expect(item('Task')).toHaveAttribute('aria-level', '3');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Nested by: Parent' })).toBeVisible();
  await expect(item('Epic')).toHaveAttribute('aria-level', '1');
  await expect(item('Story')).toHaveAttribute('aria-level', '2');
  await expect(item('Task')).toHaveAttribute('aria-level', '3');
});
