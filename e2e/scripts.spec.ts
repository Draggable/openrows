import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Browser scripts against the mocked API (e2e/fixtures/mockApi.ts) and the real server's
// sandbox document (GET /sandbox/script, with its own CSP). The three samples run end to end
// (prompts, output, writes through the records API); a hostile script can't reach the app's
// DOM, cookies, storage or network; a refused write reaches the script as an error; Stop ends a
// busy loop without freezing the page; editors run but don't edit; read-only members don't see
// scripts.

const SCRIPTS_URL = `/b/${IDS.base}/scripts`;
const output = (page: Page) => page.getByTestId('script-output');

type MockScript = { id: string; name: string; description: string; code: string };

/** The base's saved scripts, kept in memory; `canEdit` per the role. */
async function mockScripts(page: Page, initial: MockScript[] = [], canEdit = true) {
  const scripts = [...initial];
  let n = 0;
  const shape = (s: MockScript) => ({
    ...s,
    baseId: IDS.base,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
  });
  await page.route(`**/api/bases/${IDS.base}/scripts**`, async (route) => {
    const req = route.request();
    const id = new URL(req.url()).pathname.split('/')[5];
    const body = req.postData() ? JSON.parse(req.postData() ?? '{}') : {};
    const reply = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (!id && req.method() === 'GET') {
      return reply({ scripts: scripts.map(shape), canEdit });
    }
    if (!id && req.method() === 'POST') {
      n += 1;
      const s = {
        id: `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        name: body.name,
        description: body.description ?? '',
        code: body.code ?? '',
      };
      scripts.push(s);
      return reply(shape(s), 201);
    }
    const s = scripts.find((x) => x.id === id);
    if (!s) return reply({}, 404);
    if (req.method() === 'PATCH') {
      Object.assign(s, body);
      return reply(shape(s));
    }
    if (req.method() === 'DELETE') {
      scripts.splice(scripts.indexOf(s), 1);
      return route.fulfill({ status: 204 });
    }
    return reply(shape(s));
  });
  return scripts;
}

/** Picks `option` in the script's select prompt labelled `label`. */
async function choose(page: Page, label: string, option: string) {
  await output(page).getByLabel(label).selectOption({ label: option });
  await output(page).getByRole('button', { name: 'Continue' }).click();
}

async function run(page: Page) {
  await page.getByRole('button', { name: 'Run', exact: true }).click();
}

const NAMES = ['Pen', 'Ink', 'pen ', 'Paper', 'Ink', 'Glue'];

test('runs the dedupe, bulk update and report samples', async ({ page }) => {
  const api = await mockApi(page, { rows: NAMES.length, demo: { names: NAMES } });
  await mockScripts(page);
  await page.goto(SCRIPTS_URL);
  await expect(page.getByRole('heading', { level: 1, name: 'Scripts' })).toBeVisible();

  // Remove duplicates: "pen " and the second "Ink" go.
  await page.getByRole('button', { name: /^Remove duplicates/ }).click();
  await expect(page.getByRole('heading', { name: 'Remove duplicates' })).toBeVisible();
  await run(page);
  await choose(page, 'Table to clean up', 'Features');
  await choose(page, 'Field that should be unique', 'Name');
  await expect(output(page)).toContainText('2 duplicate records in Features.');
  await expect(output(page).getByRole('table')).toContainText('pen');
  await output(page).getByRole('button', { name: 'Delete' }).click();
  await expect(output(page)).toContainText('Deleted 2 records.');
  await expect(page.getByRole('status')).toHaveText('Finished');
  expect(api.liveCount()).toBe(4);
  expect(api.calls).toContain(`POST /api/tables/${IDS.table}/records/delete`);

  // Find and replace: "Pen" → "Pencil" through the bulk PATCH.
  await page.getByRole('link', { name: 'All scripts' }).click();
  await page.getByRole('button', { name: /^Find and replace/ }).click();
  await run(page);
  await choose(page, 'Table', 'Features');
  await choose(page, 'Text field to change', 'Name');
  await output(page).getByLabel('Find').fill('Pen');
  await output(page).getByRole('button', { name: 'Continue' }).click();
  await output(page).getByLabel('Replace with').fill('Pencil');
  await output(page).getByRole('button', { name: 'Continue' }).click();
  await expect(output(page)).toContainText('Updated 1 records.');
  expect(api.fieldsAt(0)[IDS.name]).toBe('Pencil');
  expect(api.bulkPatches).toEqual([1]);

  // Summary report: a table of the values.
  await page.getByRole('link', { name: 'All scripts' }).click();
  await page.getByRole('button', { name: /^Summary report/ }).click();
  await run(page);
  await choose(page, 'Table', 'Features');
  await choose(page, 'Group by', 'Name');
  await expect(output(page).getByRole('heading', { name: 'Features by Name' })).toBeVisible();
  const report = output(page).getByRole('table');
  await expect(report.getByRole('columnheader')).toHaveText(['Name', 'Records']);
  await expect(report.getByRole('row', { name: /Pencil 1/ })).toBeVisible();
  await expect(output(page)).toContainText('4 records in total.');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations).toEqual([]);
});

test("can't read the app's DOM, cookies, storage or tokens, nor reach the network", async ({
  page,
  baseURL,
  cspViolations,
}) => {
  const api = await mockApi(page, { rows: 2 });
  const origin = new URL(baseURL ?? 'http://localhost').origin;
  const probe = `${origin}/api/script-probe`;
  const code = [
    'const tries = {',
    "  document: () => typeof document === 'undefined' ? 'none' : document.cookie,",
    "  parent: () => typeof parent === 'undefined' ? 'none' : parent.document.title,",
    "  storage: () => typeof localStorage === 'undefined' ? 'none' : localStorage.length,",
    "  indexedDB: () => indexedDB.open('x') && 'opened',",
    '  origin: () => self.origin,',
    '};',
    'for (const [name, f] of Object.entries(tries)) {',
    "  try { output.text(name + ': ' + f()); } catch (err) { output.text(name + ': blocked ' + err.name); }",
    '}',
    `try { await fetch('${probe}', { credentials: 'include' }); output.text('fetch: reached'); }`,
    "catch (err) { output.text('fetch: blocked'); }",
    `try { importScripts('${origin}/theme.js'); output.text('import: loaded'); }`,
    "catch (err) { output.text('import: blocked'); }",
    `const ws = new WebSocket('${origin.replace('http', 'ws')}/ws');`,
    "await new Promise((r) => { ws.onerror = () => r(output.text('websocket: blocked')); ws.onopen = () => r(output.text('websocket: open')); });",
    "output.text('done');",
  ].join('\n');
  await mockScripts(page, [
    { id: '0a000000-0000-4000-8000-0000000000aa', name: 'Probe', description: '', code },
  ]);
  const probed: string[] = [];
  page.on('request', (req) => {
    if (req.url().startsWith(probe)) probed.push(req.url());
  });
  await page.context().addCookies([{ name: 'probe', value: 'secret', url: origin }]);
  await page.goto(`${SCRIPTS_URL}?s=0a000000-0000-4000-8000-0000000000aa`);
  await run(page);
  await expect(output(page)).toContainText('done');
  const text = await output(page).innerText();
  expect(text).toContain('document: none');
  expect(text).toContain('parent: none');
  expect(text).toContain('storage: none');
  expect(text).toMatch(/indexedDB: blocked/);
  expect(text).toContain('origin: null');
  expect(text).toContain('fetch: blocked');
  expect(text).toContain('import: blocked');
  expect(text).toContain('websocket: blocked');
  expect(text).not.toContain('secret');
  expect(probed).toEqual([]);
  expect(api.calls.some((c) => c.includes('script-probe'))).toBe(false);
  // The frame is sandboxed without allow-same-origin.
  await expect(page.locator('iframe[title="Script sandbox"]')).toHaveCount(0);
  // The blocked requests are the sandbox's CSP at work, reported by the browser; nothing else.
  const own = cspViolations.splice(0);
  for (const v of own) expect(v).toMatch(/connect-src|script-src|worker-src|blob:null|Refused/);
});

test("a refused write reaches the script as an error, and the app's data stays as it was", async ({
  page,
}) => {
  const api = await mockApi(page, {
    rows: 2,
    fieldPermissions: { [IDS.name]: { edit: { level: 'creators' } } },
    role: 'editor',
  });
  const code = [
    "const table = base.getTable('Features');",
    'const query = await table.selectRecordsAsync();',
    'try {',
    "  await table.updateRecordsAsync([{ id: query.records[0].id, fields: { Name: 'Hacked' } }]);",
    "  output.text('updated');",
    '} catch (err) {',
    "  output.text('refused: ' + err.message);",
    '}',
    "await table.updateRecordAsync(query.records[0], { Name: 'Again' });",
  ].join('\n');
  await mockScripts(
    page,
    [{ id: '0a000000-0000-4000-8000-0000000000bb', name: 'Edit names', description: '', code }],
    false
  );
  await page.goto(`${SCRIPTS_URL}?s=0a000000-0000-4000-8000-0000000000bb`);
  // Editors run scripts but don't change them.
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Code of Edit names' })).toHaveAttribute(
    'contenteditable',
    'false'
  );
  await run(page);
  await expect(output(page)).toContainText('refused: ');
  await expect(output(page).getByRole('alert')).toContainText('(line 9)');
  await expect(page.getByRole('status')).toHaveText('Failed');
  await expect(output(page)).not.toContainText('updated');
  expect(api.fieldsAt(0)[IDS.name]).toBe('Record 1');
  expect(api.restrictedWrites.length).toBeGreaterThan(0);
});

test('Stop ends a busy script and the page stays responsive', async ({ page }) => {
  await mockApi(page, { rows: 1 });
  await mockScripts(page, [
    {
      id: '0a000000-0000-4000-8000-0000000000cc',
      name: 'Forever',
      description: '',
      code: "output.text('looping');\nwhile (true) {}",
    },
  ]);
  await page.goto(`${SCRIPTS_URL}?s=0a000000-0000-4000-8000-0000000000cc`);
  await run(page);
  await expect(output(page)).toContainText('looping');
  await expect(page.getByRole('status')).toHaveText('Running…');
  // The loop runs in the sandbox's worker, so the app still answers.
  await page.getByRole('textbox', { name: 'Name' }).fill('Forever and ever');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('status')).toHaveText('Stopped');
  await expect(page.locator('iframe[title="Script sandbox"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
});

test('creators write, save, run and delete a script', async ({ page }) => {
  await mockApi(page, { rows: 1 });
  const scripts = await mockScripts(page);
  await page.goto(SCRIPTS_URL);
  await page.getByRole('button', { name: /^Blank script/ }).click();
  await expect(page.getByRole('heading', { name: 'Untitled script' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Name' }).fill('Hello');
  await page.getByRole('textbox', { name: 'Code of Untitled script' }).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type("output.text('hi ' + session.currentUser.name)");
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeDisabled();
  expect(scripts[0]).toMatchObject({ name: 'Hello' });
  expect(scripts[0]?.code).toContain("output.text('hi ' + session.currentUser.name)");
  await run(page);
  await expect(output(page)).toContainText('hi Ada Lovelace');

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Scripts' })).toBeVisible();
  expect(scripts).toEqual([]);
});

test("read-only members don't see scripts", async ({ page }) => {
  await mockApi(page, { rows: 1, role: 'read_only' });
  await page.goto(SCRIPTS_URL);
  await expect(
    page.getByText("Only the base's editors, creators and owners run scripts.")
  ).toBeVisible();
});
