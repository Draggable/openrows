import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Public forms against the Compose stack (E2E_STACK=1; development, so no CAPTCHA): the
// dev user publishes a form view from the view menu, a signed-out visitor fills it in (with a
// prefilled, hidden answer and a conditional field) and the record appears in the table as the
// "Form" actor; a flood of submissions from one visitor hits the rate limit (429).
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

test('publish a form, submit it signed out with prefill, hit the rate limit', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const call = async <T>(method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](path, { data, headers: { origin } });
    expect(res.ok(), `${method} ${path}`).toBe(true);
    return (await res.json()) as T;
  };
  const ws = await call<{ id: string }>('post', '/api/workspaces', { name: `Forms ${stamp}` });
  const base = await call<{ id: string }>('post', `/api/workspaces/${ws.id}/bases`, {
    name: 'Intake',
  });
  const table = await call<{ id: string; fields: Field[] }>(
    'post',
    `/api/bases/${base.id}/tables`,
    { name: 'Requests' }
  );
  const field = (name: string) => {
    const f = table.fields.find((x) => x.name === name);
    if (!f) throw new Error(`no ${name} field`);
    return f;
  };
  const [name, notes, status] = [field('Name'), field('Notes'), field('Status')];
  const done = status.options.choices?.find((c) => c.name === 'Done')?.id;
  const form = await call<{ id: string }>('post', `/api/tables/${table.id}/views`, {
    name: 'Request form',
    type: 'form',
  });
  await call('patch', `/api/views/${form.id}`, {
    form: {
      title: 'Request access',
      submitMessage: 'We got it.',
      fields: [
        { fieldId: name.id, required: true },
        { fieldId: status.id, allowPrefill: true },
        {
          fieldId: notes.id,
          label: 'What happened?',
          condition: { conditions: [{ fieldId: status.id, operator: 'is', value: done }] },
        },
      ],
    },
  });

  let link = '';
  await test.step('publish the form from the view menu', async () => {
    await page.goto(`/b/${base.id}/${table.id}/${form.id}`);
    await page.getByRole('button', { name: 'Request form options' }).click();
    await page.getByRole('menuitem', { name: 'Share form' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share Request form' });
    await expect(dialog.getByText('No links yet: the form is private.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Create form link' }).click();
    const input = dialog.getByLabel('Form link', { exact: true });
    await expect(input).toHaveValue(new RegExp(`^${origin}/f/[A-Za-z0-9_-]{43}$`));
    link = await input.inputValue();
    await expectNoSeriousAxeViolations(page);
  });

  const visitor = await browser.newContext();
  const violations = await watchCsp(visitor, origin);
  const guest = await visitor.newPage();
  try {
    await test.step('a signed-out visitor submits, with a prefilled hidden answer', async () => {
      const res = await guest.goto(`${link}?prefill_Status=Done&hide_Status=true`);
      expect(res?.headers()['x-robots-tag']).toContain('noindex');
      expect(res?.headers()['referrer-policy']).toBe('no-referrer');
      const formEl = guest.getByRole('form', { name: 'Request access' });
      await expect(formEl).toBeVisible();
      // Status is prefilled and hidden; Notes shows because Status is Done.
      await expect(formEl.getByLabel('Status')).toHaveCount(0);
      await expect(formEl.getByLabel('What happened?')).toBeVisible();
      // The same credit as shared views.
      await expect(guest.getByRole('link', { name: /^Made with OpenRows$/ })).toBeVisible();
      await expectNoSeriousAxeViolations(guest);
      // The required Name is checked before sending.
      await formEl.getByRole('button', { name: 'Submit' }).click();
      await expect(formEl.getByText('An answer is required.')).toBeVisible();
      await formEl.getByLabel(/Name/).fill(`Laptop ${stamp}`);
      await formEl.getByLabel('What happened?').fill('It broke');
      await formEl.getByRole('button', { name: 'Submit' }).click();
      await expect(guest.getByTestId('form-submitted')).toContainText('We got it.');
      // Signed out: the app's own API stays closed to this visitor.
      expect((await guest.request.get(`/api/tables/${table.id}`)).status()).toBe(401);
    });

    await test.step('the record is in the table, made by the form', async () => {
      const { records } = await call<{
        records: { fields: Record<string, unknown>; createdBy: string | null }[];
      }>('get', `/api/tables/${table.id}/records`);
      const made = records.find((r) => r.fields[name.id] === `Laptop ${stamp}`);
      expect(made?.fields[status.id]).toBe(done);
      expect(made?.fields[notes.id]).toBe('It broke');
      expect(made?.createdBy).toBeNull();
    });

    await test.step('a flood of submissions from one visitor is rate-limited', async () => {
      const token = new URL(link).pathname.split('/')[2];
      const statuses: number[] = [];
      for (let i = 0; i < 25 && !statuses.includes(429); i++) {
        const res = await guest.request.post(`/api/forms/${token}/submissions`, {
          headers: { origin },
          data: { submissionId: crypto.randomUUID(), fields: { [name.id]: `Flood ${i}` } },
        });
        statuses.push(res.status());
      }
      expect(statuses).toContain(429);
    });
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await visitor.close();
  }
});

// a linked record field on a public form. The form's creator picks the view whose records
// submitters may choose in the builder; a signed-out visitor searches that view's records by
// name (a record outside it never shows), picks one and submits; the record links it.
test('submit a form with a linked record picked from the chosen view', async ({
  page,
  browser,
}) => {
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
    name: 'Access',
  });
  const newTable = (name: string) =>
    call<{ id: string; fields: Field[] }>('post', `/api/bases/${base.id}/tables`, { name });
  const requests = await newTable('Requests');
  const teams = await newTable('Teams');
  const primary = (t: { fields: Field[] }) => {
    const f = t.fields.find((x) => x.name === 'Name');
    if (!f) throw new Error('no Name field');
    return f;
  };
  const active = await call<Field>('post', `/api/tables/${teams.id}/fields`, {
    name: 'Active',
    type: 'checkbox',
  });
  const teamIds: Record<string, string> = {};
  for (const [name, on] of [
    ['Alpha squad', true],
    ['Beta squad', true],
    ['Gamma squad', false],
  ] as const) {
    const r = await call<{ id: string }>('post', `/api/tables/${teams.id}/records`, {
      fields: { [primary(teams).id]: name, [active.id]: on },
    });
    teamIds[name] = r.id;
  }
  const activeView = await call<{ id: string }>('post', `/api/tables/${teams.id}/views`, {
    name: 'Active teams',
  });
  await call('patch', `/api/views/${activeView.id}`, {
    query: { filter: { conditions: [{ fieldId: active.id, operator: 'is', value: true }] } },
  });
  const team = await call<Field>('post', `/api/tables/${requests.id}/fields`, {
    name: 'Team',
    type: 'link',
    options: { linkedTableId: teams.id },
  });
  const name = primary(requests);
  const form = await call<{ id: string }>('post', `/api/tables/${requests.id}/views`, {
    name: 'Access form',
    type: 'form',
  });
  await call('patch', `/api/views/${form.id}`, {
    form: {
      title: 'Join a team',
      fields: [
        { fieldId: name.id, required: true },
        { fieldId: team.id, required: true },
      ],
    },
  });

  await test.step('the builder says why the link is off the form, then takes a view', async () => {
    await page.goto(`/b/${base.id}/${requests.id}/${form.id}`);
    await page.getByRole('button', { name: /^Team/ }).click();
    const settings = page.getByRole('group', { name: 'Team settings' });
    await expect(settings.getByTestId('form-field-problem')).toContainText('Choose the view');
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/views/${form.id}`) && r.request().method() === 'PATCH'
    );
    await settings.getByLabel('Records people can pick').selectOption({ label: 'Active teams' });
    expect((await saved).ok()).toBe(true);
    await expect(settings.getByTestId('form-field-problem')).toHaveCount(0);
  });

  const { token } = await call<{ token: string }>('post', `/api/views/${form.id}/shares`, {});
  const visitor = await browser.newContext();
  const violations = await watchCsp(visitor, origin);
  const guest = await visitor.newPage();
  try {
    await test.step('a signed-out visitor picks a team of the view and submits', async () => {
      await guest.goto(`/f/${token}`);
      const formEl = guest.getByRole('form', { name: 'Join a team' });
      await formEl.getByLabel(/Name/).fill(`Ada ${stamp}`);
      await formEl.getByRole('button', { name: 'Add a record' }).click();
      const list = formEl.getByRole('list', { name: 'Records for Team' });
      await expect(list.getByRole('button', { name: 'Alpha squad' })).toBeVisible();
      await expect(list.getByRole('button', { name: 'Beta squad' })).toBeVisible();
      // Outside the chosen view: never listed, not even by name.
      await expect(list.getByRole('button', { name: 'Gamma squad' })).toHaveCount(0);
      await formEl.getByRole('searchbox').fill('gamma');
      await expect(formEl.getByText('No matching records.')).toBeVisible();
      await formEl.getByRole('searchbox').fill('beta');
      await expect(list.getByRole('button', { name: 'Alpha squad' })).toHaveCount(0);
      await list.getByRole('button', { name: 'Beta squad' }).click();
      await formEl.getByRole('button', { name: 'Done' }).click();
      await expect(
        formEl.getByRole('list', { name: 'Team: picked records' }).getByText('Beta squad')
      ).toBeVisible();
      await expectNoSeriousAxeViolations(guest);
      await formEl.getByRole('button', { name: 'Submit' }).click();
      await expect(guest.getByTestId('form-submitted')).toBeVisible();
    });

    await test.step('the record links the picked team', async () => {
      const { records } = await call<{ records: { fields: Record<string, unknown> }[] }>(
        'get',
        `/api/tables/${requests.id}/records`
      );
      const made = records.find((r) => r.fields[name.id] === `Ada ${stamp}`);
      expect(made?.fields[team.id]).toEqual([{ id: teamIds['Beta squad'], name: 'Beta squad' }]);
    });
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await visitor.close();
  }
});
