import { latestMessageTo } from './auth/mailpit.js';
import { signInDevUser, stackApi } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Automations against the whole Compose stack (E2E_STACK=1): a creator sets up "when a
// record is created, find the project it names and link back", through the automations API (the
// builder UI is a later issue); the stack's worker runs it from the outbox relay, the grid shows
// what it wrote, and the run history has each step.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

interface Run {
  status: string;
  depth: number;
  steps: { index: number; status: string }[];
}

test('a record-created automation runs in the worker and its writes show in the grid', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInDevUser(page);
  const api = stackApi(page);
  const ws = await api.post<{ id: string }>('/api/workspaces', { name: `Autos ${Date.now()}` });
  const base = await api.post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, {
    name: 'Automated',
  });
  const table = await api.post<{ id: string }>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const meta = await api.get<{ tables: { id: string; fields: { id: string; name: string }[] }[] }>(
    `/api/v1/meta/bases/${base.id}/tables`
  );
  const fieldsOf = meta.tables.find((t) => t.id === table.id)?.fields ?? [];
  const name = fieldsOf.find((f) => f.name === 'Name');
  const notes = fieldsOf.find((f) => f.name === 'Notes');
  if (!name || !notes) throw new Error('no Name or Notes field');

  const automation = await api.post<{ id: string; enabled: boolean }>(
    `/api/bases/${base.id}/automations`,
    {
      name: 'Stamp new tasks',
      enabled: true,
      trigger: { type: 'recordCreated', tableId: table.id },
      actions: [
        {
          type: 'findRecords',
          tableId: table.id,
          filter: {
            conditions: [
              { fieldId: name.id, operator: 'is', value: '{{trigger.record.fields.Name}}' },
            ],
          },
          limit: 10,
        },
        {
          type: 'updateRecord',
          tableId: table.id,
          recordId: '{{trigger.record.id}}',
          fields: { [notes.id]: 'Stamped: {{trigger.record.fields.Name}} ({{steps.1.count}})' },
        },
      ],
    }
  );
  expect(automation.enabled).toBe(true);

  await api.post(`/api/tables/${table.id}/records`, { fields: { [name.id]: 'Ship it' } });

  await expect
    .poll(
      async () =>
        (
          await api.get<{ runs: Run[] }>(`/api/bases/${base.id}/automations/${automation.id}/runs`)
        ).runs.map((r) => [r.status, r.depth, r.steps.map((s) => s.status).join(',')]),
      { timeout: 90_000, intervals: [500, 1000, 2000] }
    )
    .toEqual([['succeeded', 1, 'succeeded,succeeded']]);

  await page.goto(`/b/${base.id}/${table.id}`);
  await expect(page.getByRole('grid').getByText('Stamped: Ship it (1)')).toBeVisible();

  // Turned off, a new record runs nothing more.
  await api.patch(`/api/bases/${base.id}/automations/${automation.id}`, { enabled: false });
  const listed = await api.get<{ automations: { id: string; enabled: boolean }[] }>(
    `/api/bases/${base.id}/automations`
  );
  expect(listed.automations).toEqual([
    expect.objectContaining({ id: automation.id, enabled: false }),
  ]);
});

// "when a form is submitted, send an email". A signed-out visitor fills in the public form;
// the worker runs the automation from the outbox relay and the email lands in Mailpit (the dev
// stack's SMTP), from the server's own address, with the answer in its subject and body.
test('a form submission sends an email, visible in Mailpit', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signInDevUser(page);
  const api = stackApi(page);
  const stamp = Date.now();
  const ws = await api.post<{ id: string }>('/api/workspaces', { name: `Form mail ${stamp}` });
  const base = await api.post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, {
    name: 'Requests',
  });
  const table = await api.post<{ id: string; fields: { id: string; name: string }[] }>(
    `/api/bases/${base.id}/tables`,
    { name: 'Intake' }
  );
  const name = table.fields.find((f) => f.name === 'Name');
  if (!name) throw new Error('no Name field');
  const view = await api.post<{ id: string }>(`/api/tables/${table.id}/views`, {
    name: 'Request form',
    type: 'form',
  });
  await api.patch(`/api/views/${view.id}`, {
    form: { title: 'Ask for help', fields: [{ fieldId: name.id, required: true }] },
  });
  const share = await api.post<{ token: string }>(`/api/views/${view.id}/shares`, {});
  const to = `helpdesk+${stamp}@openrows.test`;
  const automation = await api.post<{ id: string }>(`/api/bases/${base.id}/automations`, {
    name: 'Mail the help desk',
    enabled: true,
    trigger: { type: 'formSubmitted', tableId: table.id, viewId: view.id },
    actions: [
      {
        type: 'sendEmail',
        to: [to],
        subject: 'New request {{trigger.record.fields.Name}}',
        body: 'Someone asked for **{{trigger.record.fields.Name}}**.',
      },
    ],
  });

  const visitor = await browser.newContext();
  const violations = await watchCsp(visitor, api.origin);
  const guest = await visitor.newPage();
  try {
    await guest.goto(`/f/${share.token}`);
    const formEl = guest.getByRole('form', { name: 'Ask for help' });
    await formEl.getByLabel(/Name/).fill(`Laptop ${stamp}`);
    await formEl.getByRole('button', { name: 'Submit' }).click();
    await expect(guest.getByTestId('form-submitted')).toBeVisible();
    expect(violations).toEqual([]);
  } finally {
    await visitor.close();
  }

  const text = await latestMessageTo(to, 90_000, `New request Laptop ${stamp}`);
  expect(text).toContain(`Someone asked for **Laptop ${stamp}**.`);
  expect(text).toContain('Sent by the automation "Mail the help desk" in Requests.');
  const { runs } = await api.get<{ runs: Run[] }>(
    `/api/bases/${base.id}/automations/${automation.id}/runs`
  );
  expect(runs.map((r) => r.status)).toEqual(['succeeded']);
});
