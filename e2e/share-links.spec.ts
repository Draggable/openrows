import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Share links against the whole Compose stack (E2E_STACK=1): the dev user shares a
// filtered grid with a hidden field from the view menu, a signed-out visitor opens the link and
// sees only the view's records and visible fields, then the link is revoked and stops working.
// A password-protected link shows nothing until its password is entered, and a base link
// shows every table with the CSV download it allows.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? '')
  );
  expect(
    serious.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}: ${n.failureSummary}`)
    )
  ).toEqual([]);
}

interface Field {
  id: string;
  name: string;
  options: { choices?: { id: string; name: string }[] };
}

test('share a view with a link, open it signed out, revoke it', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const call = async <T>(method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](path, { data, headers: { origin } });
    expect(res.ok(), `${method} ${path}`).toBe(true);
    return (await res.json()) as T;
  };
  const ws = await call<{ id: string }>('post', '/api/workspaces', { name: `Links ${stamp}` });
  const base = await call<{ id: string }>('post', `/api/workspaces/${ws.id}/bases`, {
    name: 'Launch',
  });
  const table = await call<{ id: string; fields: Field[] }>(
    'post',
    `/api/bases/${base.id}/tables`,
    { name: 'Tasks' }
  );
  const field = (name: string) => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no ${name} field`);
    return f;
  };
  const [name, notes, status] = [field('Name'), field('Notes'), field('Status')];
  const choice = (n: string) => status.options.choices?.find((c) => c.name === n)?.id;
  await call('post', `/api/tables/${table.id}/records`, {
    records: [
      {
        fields: {
          [name.id]: 'Public launch',
          [notes.id]: 'Private note',
          [status.id]: choice('Done'),
        },
      },
      { fields: { [name.id]: 'Internal draft', [status.id]: choice('Todo') } },
    ],
  });
  const { views } = await call<{ views: { id: string }[] }>('get', `/api/tables/${table.id}/views`);
  const viewId = views[0]?.id ?? '';
  await call('patch', `/api/views/${viewId}`, {
    grid: { hiddenFields: [notes.id] },
    query: {
      filter: { conditions: [{ fieldId: status.id, operator: 'is', value: choice('Done') }] },
    },
  });

  let link = '';
  await test.step('create a link from the view menu', async () => {
    await page.goto(`/b/${base.id}/${table.id}/${viewId}`);
    await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    await page.getByRole('button', { name: 'Grid view options' }).click();
    await page.getByRole('menuitem', { name: 'Share view' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share Grid view' });
    await expect(dialog.getByText('No links yet.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Create link' }).click();
    const input = dialog.getByLabel(/New link/);
    await expect(input).toHaveValue(new RegExp(`^${origin}/s/[A-Za-z0-9_-]{43}$`));
    link = await input.inputValue();
    await expect(dialog.getByRole('list', { name: 'Share links' })).toContainText('No expiry');
    await expectNoSeriousAxeViolations(page);
  });

  const visitor = await browser.newContext();
  const violations = await watchCsp(visitor, origin);
  const guest = await visitor.newPage();
  try {
    await test.step('a signed-out visitor sees just the view', async () => {
      const res = await guest.goto(link);
      expect(res?.headers()['x-robots-tag']).toContain('noindex');
      expect(res?.headers()['referrer-policy']).toBe('no-referrer');
      const grid = guest.getByRole('table', { name: 'Grid view' });
      await expect(grid.getByText('Public launch')).toBeVisible();
      await expect(guest.getByText('1 record')).toBeVisible();
      await expect(grid.getByRole('columnheader', { name: 'Notes' })).toHaveCount(0);
      await expect(guest.getByText('Internal draft')).toHaveCount(0);
      await expect(guest.getByText('Private note')).toHaveCount(0);
      await expect(guest.getByRole('link', { name: /^Made with OpenRows$/ })).toBeVisible();
      await expect(guest.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
      // Signed out: the app's own API stays closed to this visitor.
      expect((await guest.request.get(`/api/tables/${table.id}`)).status()).toBe(401);
      await expectNoSeriousAxeViolations(guest);
    });

    await test.step('revoke the link; it answers 404 from then on', async () => {
      const dialog = page.getByRole('dialog', { name: 'Share Grid view' });
      await dialog.getByRole('button', { name: 'Revoke' }).click();
      await expect(dialog.getByText('No links yet.')).toBeVisible();
      await guest.reload();
      await expect(guest.getByRole('heading', { name: 'This link isn’t available' })).toBeVisible();
      await expect(guest.getByText('Public launch')).toHaveCount(0);
      const token = new URL(link).pathname.split('/')[2];
      expect((await guest.request.get(`/api/shared/${token}`)).status()).toBe(404);
      expect(
        (await guest.request.get(`/api/shared/${token}/views/${viewId}/records`)).status()
      ).toBe(404);
    });
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await visitor.close();
  }
});

/** A workspace, base and table of two records, made through the API as the signed-in user. */
async function seedTable(page: Page, label: string) {
  const origin = new URL(page.url()).origin;
  const call = async <T>(method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](path, { data, headers: { origin } });
    expect(res.ok(), `${method} ${path}`).toBe(true);
    return (await res.json()) as T;
  };
  const ws = await call<{ id: string }>('post', '/api/workspaces', { name: label });
  const base = await call<{ id: string }>('post', `/api/workspaces/${ws.id}/bases`, {
    name: 'Launch',
  });
  const table = await call<{ id: string; fields: Field[] }>(
    'post',
    `/api/bases/${base.id}/tables`,
    { name: 'Tasks' }
  );
  const name = table.fields.find((x) => x.name === 'Name');
  if (!name) throw new Error('no Name field');
  await call('post', `/api/tables/${table.id}/records`, {
    records: [{ fields: { [name.id]: 'Secret launch' } }, { fields: { [name.id]: 'Second' } }],
  });
  const { views } = await call<{ views: { id: string }[] }>('get', `/api/tables/${table.id}/views`);
  return { origin, call, baseId: base.id, tableId: table.id, viewId: views[0]?.id ?? '' };
}

test('a password-protected link shows nothing until its password is entered', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signInDevUser(page);
  const { origin, call, viewId } = await seedTable(page, `Locked ${Date.now()}`);
  const { token } = await call<{ token: string }>('post', `/api/views/${viewId}/shares`, {
    password: 'correct horse battery',
  });

  const visitor = await browser.newContext();
  const violations = await watchCsp(visitor, origin);
  const guest = await visitor.newPage();
  try {
    await test.step('the link asks for its password and shows no data', async () => {
      await guest.goto(`/s/${token}`);
      await expect(
        guest.getByRole('heading', { name: 'This link is password protected' })
      ).toBeVisible();
      await expect(guest.getByLabel('Password', { exact: true })).toBeFocused();
      await expect(guest.getByRole('table')).toHaveCount(0);
      await expect(guest.getByText('Secret launch')).toHaveCount(0);
      for (const path of [`/api/shared/${token}`, `/api/shared/${token}/views/${viewId}/records`]) {
        const res = await guest.request.get(path);
        expect(res.status(), path).toBe(401);
        expect(await res.text()).not.toContain('Secret launch');
      }
      await expectNoSeriousAxeViolations(guest);
    });

    await test.step('a wrong password is refused', async () => {
      await guest.getByLabel('Password', { exact: true }).fill('wrong password');
      await guest.getByRole('button', { name: 'Open' }).click();
      await expect(guest.getByRole('alert')).toContainText('Incorrect password');
      await expect(guest.getByRole('table')).toHaveCount(0);
      await expect(guest.getByText('Secret launch')).toHaveCount(0);
    });

    await test.step('the right password opens the view, and a reload keeps it open', async () => {
      await guest.getByLabel('Password', { exact: true }).fill('correct horse battery');
      await guest.getByRole('button', { name: 'Open' }).click();
      const grid = guest.getByRole('table', { name: 'Grid view' });
      await expect(grid.getByText('Secret launch')).toBeVisible();
      await expect(guest.getByText('2 records')).toBeVisible();
      await guest.reload();
      await expect(
        guest.getByRole('table', { name: 'Grid view' }).getByText('Secret launch')
      ).toBeVisible();
      await expect(guest.getByLabel('Password', { exact: true })).toHaveCount(0);
      await expectNoSeriousAxeViolations(guest);
    });
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await visitor.close();
  }
});

test('a base link shows its tables and allows the CSV download it grants', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signInDevUser(page);
  const { origin, call, baseId } = await seedTable(page, `Base link ${Date.now()}`);
  await call('post', `/api/bases/${baseId}/tables`, { name: 'Projects' });
  const { token } = await call<{ token: string }>('post', `/api/bases/${baseId}/shares`, {
    allowDownload: true,
    allowCopy: false,
  });

  const visitor = await browser.newContext();
  const violations = await watchCsp(visitor, origin);
  const guest = await visitor.newPage();
  try {
    await guest.goto(`/s/${token}`);
    await expect(guest.getByRole('heading', { name: 'Launch' })).toBeVisible();
    const tabs = guest.getByRole('tablist', { name: 'Tables' });
    await expect(tabs.getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
    await expect(
      guest.getByRole('table', { name: 'Grid view' }).getByText('Secret launch')
    ).toBeVisible();
    const download = guest.getByRole('link', { name: 'Download CSV' });
    const href = await download.getAttribute('href');
    expect(href).toMatch(new RegExp(`^/api/shared/${token}/views/[0-9a-f-]{36}/export\\.csv$`));
    const csv = await guest.request.get(href ?? '');
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain('Secret launch');
    await tabs.getByRole('tab', { name: 'Projects' }).click();
    await expect(tabs.getByRole('tab', { name: 'Projects' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(guest.getByText('Secret launch')).toHaveCount(0);
    await expectNoSeriousAxeViolations(guest);
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await visitor.close();
  }
});
