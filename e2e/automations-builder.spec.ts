import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signInDevUser, stackApi } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// The automations builder against the whole Compose stack (E2E_STACK=1): for each trigger
// type, an automation is built in the UI (trigger, a "create record" step with a token from the
// picker), saved and turned on; the trigger happens; the stack's worker runs it and the run shows
// in the builder's run history, and its record in the Log table. Plus a test run, the loop guard
// in the history, and axe on the list, the editor and the history.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

interface Field {
  id: string;
  name: string;
}
interface Table {
  id: string;
  fields: Field[];
}

/** A workspace and base with a Tasks table (Name, Notes) and a Log table the steps write to. */
async function setUp(page: Page, label: string) {
  await signInDevUser(page);
  const api = stackApi(page);
  const ws = await api.post<{ id: string }>('/api/workspaces', {
    name: `Builder ${label} ${Date.now()}`,
  });
  const base = await api.post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, {
    name: 'Automated',
  });
  const tasks = await api.post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const log = await api.post<Table>(`/api/bases/${base.id}/tables`, { name: 'Log' });
  const field = (t: Table, name: string) => {
    const f = t.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no ${name} field`);
    return f;
  };
  const logged = async () =>
    (
      await api.get<{ records: { fields: Record<string, unknown> }[] }>(
        `/api/tables/${log.id}/records`
      )
    ).records.map((r) => r.fields[field(log, 'Name').id]);
  return { api, baseId: base.id, tasks, log, field, logged };
}

/** "New automation", named; it starts as "when a record is created" in the first table. */
async function newAutomation(page: Page, baseId: string, name: string) {
  await page.goto(`/b/${baseId}/automations`);
  await page.getByRole('main').getByRole('button', { name: 'New automation' }).click();
  await expect(page.getByRole('region', { name: 'When a record is created' })).toBeVisible();
  await page.getByLabel('Automation name').fill(name);
}

const when = (page: Page) => page.getByRole('region', { name: /^When |^At a scheduled time/ });

async function setTrigger(page: Page, label: string) {
  await when(page).getByLabel('Trigger').selectOption({ label });
}

/** Step 1: create a Log record named `text` followed by the token picked by its label. */
async function addLogStep(page: Page, text: string, tokenLabel: string) {
  await page.getByLabel('Add an action').selectOption({ label: 'Create record' });
  const step = page.getByRole('region', { name: 'Create record' });
  await step.getByLabel('Table').selectOption({ label: 'Log' });
  await step.getByLabel('Add a field to step 1').selectOption({ label: 'Name' });
  const input = step.getByLabel('Name', { exact: true });
  await input.fill(text);
  await step.getByRole('button', { name: 'Insert a value into Name in step 1' }).click();
  await page.getByRole('option', { name: tokenLabel, exact: true }).click();
  await expect(input).toHaveValue(new RegExp(`^${text}\\{\\{trigger\\..+\\}\\}$`));
}

async function saveAndTurnOn(page: Page, name: string) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Automation saved')).toBeVisible();
  const on = page.getByRole('switch', { name: `${name} on` });
  await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'true');
}

/** The run history's newest run, once it has the status (the history polls every 5 s). */
async function expectRun(
  page: Page,
  status: 'Succeeded' | 'Skipped' | 'Failed',
  text?: string,
  timeout = 120_000
) {
  await page.getByRole('tab', { name: 'Run history' }).click();
  const first = page.getByRole('list', { name: 'Runs' }).getByRole('listitem').first();
  await expect(first.getByRole('img', { name: status }).first()).toBeVisible({ timeout });
  if (text) await expect(first).toContainText(text);
  return first;
}

async function expectAxeClean(page: Page) {
  const axe = await new AxeBuilder({ page })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(
    axe.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('record created: built in the UI, run by the worker, in the history; axe-clean', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { api, baseId, tasks, field, logged } = await setUp(page, 'created');
  await page.goto(`/b/${baseId}/${tasks.id}`);
  await page.getByRole('link', { name: 'Automations' }).click();
  await expect(page.getByText('No automations yet')).toBeVisible();
  await expectAxeClean(page);

  await newAutomation(page, baseId, 'Log new tasks');
  await addLogStep(page, 'Created: ', 'Record › Name');
  await expectAxeClean(page);
  await saveAndTurnOn(page, 'Log new tasks');

  await api.post(`/api/tables/${tasks.id}/records`, {
    fields: { [field(tasks, 'Name').id]: 'Alpha' },
  });
  const run = await expectRun(page, 'Succeeded', 'Alpha');
  await run.locator('summary').click();
  await expect(run.getByText('Step 1: Create record')).toBeVisible();
  await expectAxeClean(page);
  expect(await logged()).toEqual(['Created: Alpha']);

  // The list: on, last run, one run.
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Automations' })
    .click();
  const row = page.getByRole('row', { name: /Log new tasks/ });
  await expect(row.getByRole('switch', { name: 'Log new tasks on' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(row).toContainText('Succeeded', { timeout: 15_000 });
  await expect(row.getByRole('cell').last()).toHaveText('1');
  await expectAxeClean(page);
});

test('record updated: a test run first, then a real one', async ({ page }) => {
  test.setTimeout(180_000);
  const { api, baseId, tasks, field, logged } = await setUp(page, 'updated');
  const record = await api.post<{ id: string }>(`/api/tables/${tasks.id}/records`, {
    fields: { [field(tasks, 'Name').id]: 'Beta' },
  });
  await newAutomation(page, baseId, 'Log updates');
  await setTrigger(page, 'When a record is updated');
  await when(page).getByRole('checkbox', { name: 'Notes' }).check();
  await addLogStep(page, 'Updated: ', 'Record › Notes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Automation saved')).toBeVisible();

  // Test with the record: the warning, then the step's output; it ran for real.
  const panel = page.getByRole('complementary', { name: 'Test and run history' });
  await expect(panel.getByRole('note')).toContainText('for real');
  await panel.getByLabel('Test with record').selectOption({ label: 'Beta' });
  await panel.getByRole('button', { name: 'Run test' }).click();
  const result = panel.getByRole('region', { name: 'Test result' });
  await expect(result).toContainText('Test succeeded');
  await expect(result).toContainText('Step 1: Create record');
  expect(await logged()).toEqual(['Updated: ']);

  const on = page.getByRole('switch', { name: 'Log updates on' });
  await on.click();
  await expect(on).toHaveAttribute('aria-checked', 'true');
  await api.patch(`/api/tables/${tasks.id}/records/${record.id}`, {
    fields: { [field(tasks, 'Notes').id]: 'shipped' },
  });
  await expect
    .poll(async () => (await logged()).includes('Updated: shipped'), { timeout: 120_000 })
    .toBe(true);
  const run = await expectRun(page, 'Succeeded', 'Beta');
  await expect(run).not.toContainText('Test');
});

test('record matches conditions', async ({ page }) => {
  test.setTimeout(180_000);
  const { api, baseId, tasks, field, logged } = await setUp(page, 'matches');
  await newAutomation(page, baseId, 'Log urgent');
  await setTrigger(page, 'When a record matches conditions');
  await when(page).getByRole('button', { name: 'Filter' }).click();
  const filter = page.getByRole('dialog', { name: 'Filter' });
  await filter.getByRole('button', { name: 'Add condition', exact: true }).click();
  await filter.getByLabel('Field').selectOption({ label: 'Notes' });
  await filter.getByLabel('Operator').selectOption({ label: 'contains' });
  await filter.getByLabel('Value of Notes').fill('urgent');
  await page.keyboard.press('Escape');
  await expect(when(page)).toContainText('1 condition');
  await addLogStep(page, 'Urgent: ', 'Record › Name');
  await saveAndTurnOn(page, 'Log urgent');

  await api.post(`/api/tables/${tasks.id}/records`, {
    fields: { [field(tasks, 'Name').id]: 'Calm' },
  });
  await api.post(`/api/tables/${tasks.id}/records`, {
    fields: { [field(tasks, 'Name').id]: 'Gamma', [field(tasks, 'Notes').id]: 'urgent fix' },
  });
  await expectRun(page, 'Succeeded', 'Gamma');
  expect(await logged()).toEqual(['Urgent: Gamma']);
});

test('form submitted', async ({ page }) => {
  test.setTimeout(180_000);
  const { api, baseId, tasks, field, logged } = await setUp(page, 'form');
  const name = field(tasks, 'Name');
  const view = await api.post<{ id: string }>(`/api/tables/${tasks.id}/views`, {
    name: 'Request form',
    type: 'form',
  });
  await api.patch(`/api/views/${view.id}`, {
    form: { title: 'Ask', fields: [{ fieldId: name.id, required: true }] },
  });
  const share = await api.post<{ token: string }>(`/api/views/${view.id}/shares`, {});
  await newAutomation(page, baseId, 'Log requests');
  await setTrigger(page, 'When a form is submitted');
  await when(page).getByLabel('Form').selectOption({ label: 'Request form' });
  await addLogStep(page, 'Asked: ', 'Record › Name');
  await saveAndTurnOn(page, 'Log requests');

  const res = await page.request.post(`/api/forms/${share.token}/submissions`, {
    headers: { origin: api.origin },
    data: { submissionId: crypto.randomUUID(), fields: { [name.id]: 'Delta' } },
  });
  expect(res.ok(), `submission: ${res.status()}`).toBe(true);
  await expectRun(page, 'Succeeded', 'Delta');
  expect(await logged()).toEqual(['Asked: Delta']);
});

test('button clicked', async ({ page }) => {
  test.setTimeout(180_000);
  const { api, baseId, tasks, field, logged } = await setUp(page, 'button');
  const button = await api.post<Field>(`/api/tables/${tasks.id}/fields`, {
    name: 'Approve',
    type: 'button',
    options: { label: 'Approve', action: 'runAutomation' },
  });
  const record = await api.post<{ id: string }>(`/api/tables/${tasks.id}/records`, {
    fields: { [field(tasks, 'Name').id]: 'Epsilon' },
  });
  await newAutomation(page, baseId, 'Log approvals');
  await setTrigger(page, 'When a button is clicked');
  await when(page).getByLabel('Button field').selectOption({ label: 'Approve' });
  await addLogStep(page, 'Approved by ', 'Clicked by › Email');
  await saveAndTurnOn(page, 'Log approvals');

  await api.post(`/api/tables/${tasks.id}/records/${record.id}/buttons/${button.id}`, {});
  await expectRun(page, 'Succeeded', 'Epsilon');
  expect(await logged()).toEqual(['Approved by dev@openrows.test']);

  // The record view's button runs it too.
  await page.goto(`/b/${baseId}/${tasks.id}?record=${record.id}`);
  const dialog = page.getByRole('dialog', { name: 'Epsilon' });
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Automation started')).toBeVisible();
  await expect
    .poll(logged, { timeout: 120_000 })
    .toEqual(['Approved by dev@openrows.test', 'Approved by dev@openrows.test']);
});

test('webhook received: the URL, a request, its sample', async ({ page }) => {
  test.setTimeout(180_000);
  const { baseId, logged } = await setUp(page, 'webhook');
  await newAutomation(page, baseId, 'Log hooks');
  await setTrigger(page, 'When a webhook is received');
  await expect(when(page).getByText('Save to get the URL.')).toBeVisible();
  await addLogStep(page, 'Hook: ', 'Body');
  await saveAndTurnOn(page, 'Log hooks');

  const url = await when(page).getByRole('textbox', { name: 'Webhook URL' }).inputValue();
  expect(url).toMatch(/\/hooks\/a\/[\w-]+$/);
  const res = await page.request.post(new URL(url).pathname, { data: { message: 'zeta' } });
  expect(res.ok(), `hook: ${res.status()}`).toBe(true);
  await expectRun(page, 'Succeeded', 'Webhook request');
  expect(await logged()).toEqual(['Hook: {"message":"zeta"}']);
  await page.reload();
  await expect(when(page).getByText('"message": "zeta"')).toBeVisible();
});

test('scheduled: runs at its start time', async ({ page }) => {
  // The scheduler checks every minute: the first run is set two minutes ahead.
  test.setTimeout(330_000);
  const { baseId, logged } = await setUp(page, 'scheduled');
  await newAutomation(page, baseId, 'Log ticks');
  await setTrigger(page, 'At a scheduled time');
  const start = new Date(Date.now() + 2 * 60_000);
  await when(page).getByLabel('Starting').fill(start.toISOString().slice(0, 16));
  await when(page).getByLabel('Time zone').fill('UTC');
  await addLogStep(page, 'Tick at ', 'Scheduled time');
  await saveAndTurnOn(page, 'Log ticks');

  await expectRun(page, 'Succeeded', 'Scheduled run', 240_000);
  expect(await logged()).toEqual([expect.stringMatching(/^Tick at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)]);
});

test('the loop guard stops an automation that keeps triggering itself, in the history', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { api, baseId, tasks, field } = await setUp(page, 'loop');
  const record = await api.post<{ id: string }>(`/api/tables/${tasks.id}/records`, {
    fields: { [field(tasks, 'Name').id]: 'Omega' },
  });
  await newAutomation(page, baseId, 'Echo');
  await setTrigger(page, 'When a record is updated');
  await page.getByLabel('Add an action').selectOption({ label: 'Update record' });
  const step = page.getByRole('region', { name: 'Update record' });
  await expect(step.getByLabel('Record ID', { exact: true })).toHaveValue('{{trigger.record.id}}');
  await step.getByLabel('Add a field to step 1').selectOption({ label: 'Notes' });
  const input = step.getByLabel('Notes', { exact: true });
  await input.fill('again ');
  await step.getByRole('button', { name: 'Insert a value into Notes in step 1' }).click();
  await page.getByRole('option', { name: 'Record › Notes', exact: true }).click();
  await saveAndTurnOn(page, 'Echo');

  await api.patch(`/api/tables/${tasks.id}/records/${record.id}`, {
    fields: { [field(tasks, 'Notes').id]: 'start' },
  });
  await page.getByRole('tab', { name: 'Run history' }).click();
  await page.getByLabel('Show').selectOption({ label: 'Skipped' });
  const stopped = await expectRun(page, 'Skipped', 'Omega');
  await stopped.locator('summary').click();
  await expect(stopped.getByRole('note')).toContainText('loop guard');
  await page.getByLabel('Show').selectOption({ label: 'All runs' });
  // Depth 1 (the person's change), 2 and 3 ran; depth 4 was stopped.
  await expect(page.getByRole('list', { name: 'Runs' }).locator(':scope > li')).toHaveCount(4, {
    timeout: 30_000,
  });
});

test("run a script (#112): not offered where the server doesn't run scripts", async ({ page }) => {
  // The Compose stack leaves AUTOMATION_SCRIPTS off (no Docker inside it): the builder says so,
  // and the API refuses a script step.
  const { api, baseId, tasks } = await setUp(page, 'script');
  await newAutomation(page, baseId, 'Scripted');
  const option = page
    .getByLabel('Add an action')
    .locator('option', { hasText: 'Run a script (not available)' });
  await expect(option).toBeDisabled();
  const { scripts } = await api.get<{ scripts: { available: boolean; reason: string } }>(
    `/api/bases/${baseId}/automations`
  );
  expect(scripts).toMatchObject({ available: false, reason: 'disabled' });
  const created = await page.request.fetch(`/api/bases/${baseId}/automations`, {
    method: 'POST',
    headers: { origin: api.origin },
    data: {
      name: 'Script',
      trigger: { type: 'recordCreated', tableId: tasks.id },
      actions: [{ type: 'runScript', script: "output.set('a', 1);" }],
    },
  });
  expect(created.status()).toBe(422);
  expect((await created.json()).errors).toEqual([
    { path: 'actions.0.type', message: "This server doesn't run scripts." },
  ]);
  await expectAxeClean(page);
});
