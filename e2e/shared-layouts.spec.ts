import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Share links of kanban and calendar views against the Compose stack (E2E_STACK=1): the
// dev user shares a kanban from the view menu and a calendar through the API, both filtered to
// Done; a signed-out visitor opens each link and sees the board's stacks and cards and the
// month's events, but not the filtered-out record or the fields the layouts don't show.
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

/** Today in this machine's zone (the browser's too), as YYYY-MM-DD. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

test('share a kanban and a calendar view, open them signed out', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const call = async <T>(method: 'post' | 'patch' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](path, { data, headers: { origin } });
    expect(res.ok(), `${method} ${path}`).toBe(true);
    return (await res.json()) as T;
  };
  const ws = await call<{ id: string }>('post', '/api/workspaces', { name: `Layouts ${stamp}` });
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
  const due = await call<Field>('post', `/api/tables/${table.id}/fields`, {
    name: 'Due',
    type: 'date',
  });
  const choice = (n: string) => status.options.choices?.find((c) => c.name === n)?.id;
  await call('post', `/api/tables/${table.id}/records`, {
    records: [
      {
        fields: {
          [name.id]: 'Public launch',
          [notes.id]: 'Private note',
          [status.id]: choice('Done'),
          [due.id]: today(),
        },
      },
      {
        fields: { [name.id]: 'Internal draft', [status.id]: choice('Todo'), [due.id]: today() },
      },
    ],
  });
  const onlyDone = {
    filter: { conditions: [{ fieldId: status.id, operator: 'is', value: choice('Done') }] },
  };
  const kanban = await call<{ id: string }>('post', `/api/tables/${table.id}/views`, {
    name: 'Board',
    type: 'kanban',
  });
  await call('patch', `/api/views/${kanban.id}`, {
    kanban: { stackFieldId: status.id, cardFields: [due.id] },
    query: onlyDone,
  });
  const calendar = await call<{ id: string }>('post', `/api/tables/${table.id}/views`, {
    name: 'Schedule',
    type: 'calendar',
  });
  await call('patch', `/api/views/${calendar.id}`, {
    calendar: { dateFields: [{ startFieldId: due.id }], mode: 'month' },
    query: onlyDone,
  });

  let kanbanLink = '';
  await test.step('share the kanban from the view menu', async () => {
    await page.goto(`/b/${base.id}/${table.id}/${kanban.id}`);
    await page.getByRole('button', { name: 'Board options' }).click();
    await page.getByRole('menuitem', { name: 'Share view' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share Board' });
    await dialog.getByRole('button', { name: 'Create link' }).click();
    const input = dialog.getByLabel(/New link/);
    await expect(input).toHaveValue(new RegExp(`^${origin}/s/[A-Za-z0-9_-]{43}$`));
    kanbanLink = await input.inputValue();
  });
  const { token } = await call<{ token: string }>('post', `/api/views/${calendar.id}/shares`, {});
  const calendarLink = `${origin}/s/${token}`;

  const visitor = await browser.newContext();
  const violations = await watchCsp(visitor, origin);
  const guest = await visitor.newPage();
  try {
    await test.step('a signed-out visitor sees the board', async () => {
      await guest.goto(kanbanLink);
      const done = guest.getByRole('region', { name: 'Done' });
      await expect(done.getByRole('article', { name: 'Public launch' })).toBeVisible();
      await expect(done.getByTestId('stack-count')).toHaveText('1');
      await expect(guest.getByRole('region', { name: 'Todo' })).toBeVisible();
      await expect(guest.getByText('Internal draft')).toHaveCount(0);
      await expect(guest.getByText('Private note')).toHaveCount(0);
      await expect(guest.getByText('1 record')).toBeVisible();
      expect((await guest.request.get(`/api/tables/${table.id}`)).status()).toBe(401);
      await expectNoSeriousAxeViolations(guest);
    });

    await test.step('a signed-out visitor sees the calendar month', async () => {
      await guest.goto(calendarLink);
      const day = guest.locator(`[data-event-start="${today()}"]`);
      await expect(day).toHaveCount(1);
      await expect(day).toContainText('Public launch');
      await expect(guest.getByText('Internal draft')).toHaveCount(0);
      await expect(guest.getByText('Private note')).toHaveCount(0);
      const month = guest.getByRole('heading', { level: 2 });
      const title = (await month.textContent()) ?? '';
      await guest.getByRole('button', { name: 'Next' }).click();
      await expect(month).not.toHaveText(title);
      await guest.getByRole('button', { name: 'Today' }).click();
      await expect(month).toHaveText(title);
      await expect(day).toHaveCount(1);
      await expectNoSeriousAxeViolations(guest);
    });
    expect(violations).toEqual([]);
  } finally {
    await visitor.close();
  }
});
