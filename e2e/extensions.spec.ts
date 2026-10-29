import AxeBuilder from '@axe-core/playwright';
import { BUILT_IN_EXTENSIONS } from '@openrows/shared';
import type { Page } from '@playwright/test';
import { GRID_URL, IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Extensions against the mocked API (e2e/fixtures/mockApi.ts) and the real server's
// sandbox document (GET /sandbox/extension, with its own CSP). The three built-in extensions
// run end to end in the base's panel (chart, print view, URL preview); an extension gets only
// the scopes its manifest declares, and can't reach the app's DOM, cookies, storage or network;
// creators arrange and remove them; read-only members see them but can't add any.

type Installed = {
  id: string;
  builtIn: string | null;
  name: string;
  manifest: {
    manifestVersion: 1;
    name: string;
    description: string;
    version: string;
    scopes: string[];
  };
  bundle: { html: string; css: string; js: string };
  size: 'small' | 'medium' | 'large';
  settings: Record<string, unknown>;
};

/** The base's extensions, kept in memory, with the list's permission flags. */
async function mockExtensions(
  page: Page,
  flags: { canManage?: boolean; canConfigure?: boolean; canInstallCustom?: boolean } = {}
) {
  const installed: Installed[] = [];
  const settingsWrites: Record<string, unknown>[] = [];
  let n = 0;
  const shape = (e: Installed, position: number) => ({
    id: e.id,
    baseId: IDS.base,
    builtIn: e.builtIn,
    name: e.name,
    manifest: e.manifest,
    size: e.size,
    position,
    settings: e.settings,
    createdBy: null,
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
  });
  const list = () => ({
    extensions: installed.map(shape),
    canManage: flags.canManage ?? true,
    canConfigure: flags.canConfigure ?? true,
    canInstallCustom: flags.canInstallCustom ?? true,
  });
  await page.route(`**/api/bases/${IDS.base}/extensions**`, async (route) => {
    const req = route.request();
    const parts = new URL(req.url()).pathname.split('/');
    const id = parts[5];
    const sub = parts[6];
    const body = req.postData() ? JSON.parse(req.postData() ?? '{}') : {};
    const reply = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (!id && req.method() === 'GET') return reply(list());
    if (!id && req.method() === 'POST') {
      n += 1;
      const builtIn = BUILT_IN_EXTENSIONS.find((e) => e.key === body.builtIn);
      const manifest = builtIn ? builtIn.manifest : body.manifest;
      const e: Installed = {
        id: `0b000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        builtIn: builtIn?.key ?? null,
        name: manifest.name,
        manifest: { description: '', version: '1.0.0', ...manifest },
        bundle: builtIn ? builtIn.bundle : { html: '', css: '', js: '', ...body.bundle },
        size: 'medium',
        settings: {},
      };
      installed.push(e);
      return reply(shape(e, installed.length - 1), 201);
    }
    if (id === 'order' && req.method() === 'PUT') {
      const order: string[] = body.ids;
      installed.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      return reply(list());
    }
    const e = installed.find((x) => x.id === id);
    if (!e) return reply({}, 404);
    const at = installed.indexOf(e);
    if (sub === 'bundle') return reply({ manifest: e.manifest, bundle: e.bundle });
    if (sub === 'settings' && req.method() === 'PUT') {
      e.settings = body.settings;
      settingsWrites.push(body.settings);
      return reply(shape(e, at));
    }
    if (req.method() === 'PATCH') {
      Object.assign(e, body);
      return reply(shape(e, at));
    }
    if (req.method() === 'DELETE') {
      installed.splice(at, 1);
      return route.fulfill({ status: 204 });
    }
    return reply(shape(e, at));
  });
  return { installed, settingsWrites };
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Extensions' });
const frame = (page: Page, name: string) => page.frameLocator(`iframe[title="${name} extension"]`);

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Extensions', exact: true }).click();
  await expect(panel(page)).toBeVisible();
}

async function add(page: Page, name: string) {
  await panel(page).getByRole('button', { name: 'Add extension' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add an extension' });
  await dialog.getByRole('button', { name: `Add ${name}` }).click();
  await expect(dialog).toBeHidden();
  await expect(panel(page).getByRole('heading', { level: 3, name })).toBeVisible();
}

/** Selects a grid cell of row `i` (the cursor). */
async function selectRow(page: Page, i: number) {
  await page
    .getByRole('row')
    .nth(i + 1)
    .getByRole('gridcell')
    .nth(1)
    .click();
}

const NAMES = ['Pen', 'Ink', 'Pen', 'Glue'];
const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test('runs the chart, print view and URL preview samples in the panel', async ({ page }) => {
  await mockApi(page, {
    rows: NAMES.length,
    demo: {
      names: NAMES,
      fields: [{ id: IDS.site, name: 'Site', type: 'url', position: 5 }],
      cells: (i) => ({ [IDS.site]: i === 0 ? VIDEO : i === 1 ? 'https://example.com/a' : null }),
    },
  });
  const { settingsWrites } = await mockExtensions(page);
  // The embed itself isn't the point: answer it locally.
  await page.route('https://www.youtube-nocookie.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>video</p>' })
  );
  await page.goto(GRID_URL);
  await openPanel(page);
  await expect(panel(page)).toContainText('No extensions on this base yet.');

  // Chart: pick the field to group by; the bars count the records.
  await add(page, 'Chart');
  const chart = frame(page, 'Chart');
  await chart.getByLabel('Group by').selectOption({ label: 'Name' });
  await expect(chart.getByRole('heading', { name: 'Features by Name' })).toBeVisible();
  await expect(chart.locator('li[data-label="Pen"] .count')).toHaveText('2');
  await expect(chart.locator('li[data-label="Glue"] .count')).toHaveText('1');
  await expect(chart.getByText('4 records')).toBeVisible();
  expect(settingsWrites.at(-1)).toMatchObject({ tableId: IDS.table, fieldId: IDS.name });

  // Print view: follows the selected record; choose the fields on the page.
  await add(page, 'Print view');
  const print = frame(page, 'Print view');
  await expect(print.getByText('Select a record to lay it out for printing.')).toBeVisible();
  await selectRow(page, 1);
  await expect(print.getByRole('heading', { level: 1, name: 'Ink' })).toBeVisible();
  await expect(print.getByRole('button', { name: 'Print' })).toBeVisible();
  await expect(print.locator('dt', { hasText: 'Notes' })).toBeVisible();
  await print.getByRole('button', { name: 'Choose fields' }).click();
  await print.getByRole('checkbox', { name: 'Notes' }).uncheck();
  await expect(print.locator('dt', { hasText: 'Notes' })).toHaveCount(0);
  await selectRow(page, 3);
  await expect(print.getByRole('heading', { level: 1, name: 'Glue' })).toBeVisible();

  // URL preview: a video embeds; another site gets the link only.
  await add(page, 'URL preview');
  const preview = frame(page, 'URL preview');
  await selectRow(page, 0);
  await expect(preview.locator('iframe')).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
  );
  await selectRow(page, 1);
  await expect(preview.getByText('No preview for this site.')).toBeVisible();
  // The new tab is a page of its own: only a context route answers it (CI has no internet).
  await page
    .context()
    .route('https://example.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<p>example</p>' })
    );
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    preview.getByRole('button', { name: 'Open link' }).click(),
  ]);
  await expect(popup).toHaveURL('https://example.com/a');
  await popup.close();

  const results = await new AxeBuilder({ page })
    .include('[aria-label="Extensions"]')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('creators arrange and remove extensions; read-only members only see them', async ({
  page,
}) => {
  await mockApi(page, { rows: 2 });
  const { installed } = await mockExtensions(page);
  await page.goto(GRID_URL);
  await openPanel(page);
  await add(page, 'Chart');
  await add(page, 'Print view');
  const titles = panel(page).getByRole('heading', { level: 3 });
  await expect(titles).toHaveText(['Chart', 'Print view']);
  await panel(page).getByRole('button', { name: 'Print view options' }).click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();
  await expect(titles).toHaveText(['Print view', 'Chart']);
  expect(installed.map((e) => e.name)).toEqual(['Print view', 'Chart']);
  await panel(page).getByRole('button', { name: 'Chart options' }).click();
  await page.getByRole('menuitem', { name: 'Make large' }).click();
  await expect(page.locator('iframe[title="Chart extension"]')).toHaveCSS('height', '560px');
  await panel(page).getByRole('button', { name: 'Chart options' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(titles).toHaveText(['Print view']);

  // The panel stays open across reloads; read-only members get no Add.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockApi(page, { rows: 2, role: 'read_only' });
  const ro = await mockExtensions(page, {
    canManage: false,
    canConfigure: false,
    canInstallCustom: false,
  });
  ro.installed.push({ ...installed[0], id: '0b000000-0000-4000-8000-0000000000ff' } as Installed);
  await page.reload();
  await expect(panel(page).getByRole('heading', { level: 3, name: 'Print view' })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Add extension' })).toHaveCount(0);
});

test('an extension gets only its manifest’s scopes and stays in its sandbox', async ({
  page,
  baseURL,
  cspViolations,
}) => {
  const api = await mockApi(page, { rows: 2 });
  await mockExtensions(page);
  const origin = new URL(baseURL ?? 'http://localhost').origin;
  const probe = `${origin}/api/extension-probe`;
  const js = [
    'const out = (t) => { const p = document.createElement("p"); p.textContent = t; document.body.append(p); };',
    'const b = window.openrows;',
    'out("scopes: " + b.scopes.join(","));',
    'out("tables: " + b.base.tables.length);',
    'out("cursor: " + (b.cursor ? b.cursor.tableId : "none"));',
    'const tries = {',
    '  cookie: () => document.cookie,',
    '  parent: () => parent.document.title,',
    '  storage: () => localStorage.length,',
    '  origin: () => self.origin,',
    '};',
    'for (const [name, f] of Object.entries(tries)) {',
    '  try { out(name + ": " + f()); } catch (err) { out(name + ": blocked " + err.name); }',
    '}',
    '(async () => {',
    `  const tableId = "${IDS.table}";`,
    '  try { await b.selectRecords(tableId); out("select: allowed"); } catch (err) { out("select: " + err.message); }',
    // A hostile extension skips the runtime: it takes the port and sends raw calls.
    '  let port = null;',
    '  const send = MessagePort.prototype.postMessage;',
    '  MessagePort.prototype.postMessage = function (m) { port = this; return send.call(this, m); };',
    '  await b.openUrl("ftp://nowhere").catch(() => {});',
    '  MessagePort.prototype.postMessage = send;',
    '  const raw = (id, method, args) => new Promise((resolve) => {',
    '    const prev = port.onmessage;',
    '    port.onmessage = (e) => { if (e.data && e.data.id === id) { port.onmessage = prev; resolve(e.data); } else prev(e); };',
    '    port.postMessage({ type: "call", id, method, args });',
    '  });',
    '  const r1 = await raw(9001, "select", { tableId });',
    '  out("raw select: " + (r1.ok ? "allowed" : r1.error));',
    `  const r2 = await raw(9002, "create", { tableId, records: [{ fields: { "${IDS.name}": "Hacked" } }] });`,
    '  out("raw create: " + (r2.ok ? "allowed" : r2.error));',
    '  try { await b.setSettings({ x: 1 }); out("settings: allowed"); } catch (err) { out("settings: " + err.message); }',
    `  try { await fetch("${probe}", { credentials: "include" }); out("fetch: reached"); } catch { out("fetch: blocked"); }`,
    '  out("done");',
    '})();',
  ].join('\n');
  const pkg = {
    manifest: { manifestVersion: 1, name: 'Probe', version: '0.1.0', scopes: ['cursor:read'] },
    bundle: { html: '<main></main><script>document.title = "inline ran"</script>', js },
  };
  const probed: string[] = [];
  page.on('request', (req) => {
    if (req.url().startsWith(probe)) probed.push(req.url());
  });
  await page.context().addCookies([{ name: 'probe', value: 'secret', url: origin }]);
  await page.goto(GRID_URL);
  await openPanel(page);
  await panel(page).getByRole('button', { name: 'Add extension' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add an extension' });
  await dialog.getByLabel('Choose a package file').setInputFiles({
    name: 'probe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pkg)),
  });
  await expect(dialog).toContainText('See the table, view and record you have selected');
  await dialog.getByRole('button', { name: 'Install Probe' }).click();

  const f = frame(page, 'Probe');
  await expect(f.getByText('done')).toBeVisible();
  const text = await f.locator('body').innerText();
  expect(text).toContain('scopes: cursor:read');
  expect(text).toContain('tables: 0');
  expect(text).toContain(`cursor: ${IDS.table}`);
  expect(text).toMatch(/cookie: blocked|cookie: \n/);
  expect(text).toMatch(/parent: blocked/);
  expect(text).toMatch(/storage: blocked/);
  expect(text).toContain('origin: null');
  expect(text).toContain("select: This extension's manifest doesn't ask for records:read.");
  expect(text).toContain(
    "raw select: This extension may not read records (its manifest doesn't ask for records:read)."
  );
  expect(text).toContain(
    "raw create: This extension may not change records (its manifest doesn't ask for records:write)."
  );
  expect(text).toContain("settings: This extension's manifest doesn't ask for settings:write.");
  expect(text).toContain('fetch: blocked');
  expect(text).not.toContain('secret');
  expect(text).not.toContain('inline ran');
  expect(probed).toEqual([]);
  // Nothing reached the records API's writes.
  expect(api.calls.filter((c) => c.startsWith('POST') && c.endsWith('/records'))).toEqual([]);
  // The blocked requests are the sandbox's CSP at work, reported by the browser; nothing else.
  const own = cspViolations.splice(0);
  for (const v of own) expect(v).toMatch(/connect-src|script-src|blob:null|Refused/);
});
