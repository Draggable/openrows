import { createHmac } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { signInDevUser, stackApi } from './helpers/stack.js';
import { expect, test } from './helpers/test.js';

// Webhooks against the whole Compose stack (E2E_STACK=1): a creator adds a webhook from
// the base menu to the stack's test receiver (docker/webhook-receiver.mjs, the one allowlisted
// http host in dev.yml), edits a record, and sees the worker's signed delivery in the log.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

/** The receiver: in CI's network namespace and on the dev machine both, at localhost:8190. */
const RECEIVER = process.env['E2E_WEBHOOK_RECEIVER_URL'] ?? 'http://localhost:8190';

interface Received {
  path: string;
  headers: Record<string, string>;
  body: string;
}

test('creates a webhook, edits a record and sees the signed delivery in the log', async ({
  page,
  playwright,
}) => {
  test.setTimeout(120_000);
  await signInDevUser(page);
  const api = stackApi(page);
  const ws = await api.post<{ id: string }>('/api/workspaces', { name: `Hooks ${Date.now()}` });
  const base = await api.post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, {
    name: 'Hooked',
  });
  const table = await api.post<{ id: string }>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const meta = await api.get<{ tables: { id: string; fields: { id: string; name: string }[] }[] }>(
    `/api/v1/meta/bases/${base.id}/tables`
  );
  const notes = meta.tables.find((t) => t.id === table.id)?.fields.find((f) => f.name === 'Notes');
  if (!notes) throw new Error('no Notes field');
  const record = await api.post<{ id: string }>(`/api/tables/${table.id}/records`, { fields: {} });
  const path = `/e2e-${Date.now()}`;

  await page.goto(`/b/${base.id}/${table.id}`);
  await page.getByRole('button', { name: 'Switch base' }).click();
  await page.getByRole('menuitem', { name: 'Webhooks' }).click();
  const dialog = page.getByRole('dialog', { name: 'Webhooks' });
  await expect(dialog.getByText('No webhooks yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'New webhook' }).click();
  const form = dialog.getByRole('form', { name: 'New webhook' });
  await form.getByLabel('URL').fill(`http://webhook-receiver:8190${path}`);
  await form.getByLabel('Description').fill('E2E receiver');
  await expect(form.getByRole('checkbox', { name: 'Records: Updated' })).toBeChecked();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
  await form.getByRole('button', { name: 'Create webhook' }).click();

  const secretField = dialog
    .getByRole('region', { name: 'Signing secret' })
    .getByLabel('Signing secret');
  await expect(secretField).toHaveValue(/^whsec_[A-Za-z0-9_-]{43}$/);
  const secret = await secretField.inputValue();
  const row = dialog.getByRole('listitem').filter({ hasText: path });
  await expect(row).toContainText('E2E receiver');

  // Edit the record: the outbox relay hands it to the worker, which POSTs it, signed.
  const res = await page.request.patch(`/api/tables/${table.id}/records`, {
    data: { records: [{ id: record.id, fields: { [notes.id]: 'Shipped' } }] },
    headers: { origin: api.origin },
  });
  expect(res.ok()).toBe(true);

  await row.getByRole('button', { name: 'Delivery log' }).click();
  const log = dialog.getByRole('list', { name: 'Deliveries' });
  await expect(log.getByRole('listitem').filter({ hasText: 'Records: Updated' })).toContainText(
    'HTTP 200',
    { timeout: 90_000 }
  );

  // What the receiver got: one signed record.updated for this record.
  const receiver = await playwright.request.newContext();
  const got = (await (
    await receiver.get(`${RECEIVER}/requests?path=${encodeURIComponent(path)}`)
  ).json()) as Received[];
  await receiver.dispose();
  expect(got).toHaveLength(1);
  const [delivery] = got;
  const signature = delivery?.headers['x-openrows-signature'] ?? '';
  const [, t = '', v1 = ''] = signature.match(/^t=(\d+),v1=([0-9a-f]{64})$/) ?? [];
  expect(createHmac('sha256', secret).update(`${t}.${delivery?.body}`).digest('hex')).toBe(v1);
  expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(300);
  const payload = JSON.parse(delivery?.body ?? '{}') as Record<string, unknown>;
  expect(payload).toMatchObject({
    type: 'record.updated',
    base: { id: base.id, name: 'Hooked' },
    table: { id: table.id, name: 'Tasks' },
    record: { id: record.id, after: { [notes.id]: 'Shipped' } },
  });
  expect(delivery?.headers['x-openrows-event-id']).toBe(payload['id']);

  // Rotation with a grace period: the old secret keeps signing for 24 hours.
  page.on('dialog', (d) => void d.accept());
  await dialog.getByRole('button', { name: 'Webhooks', exact: true }).click();
  await dialog
    .getByRole('button', {
      name: `Rotate the signing secret of http://webhook-receiver:8190${path}`,
    })
    .click();
  await expect(secretField).not.toHaveValue(secret);
  await expect(secretField).toHaveValue(/^whsec_/);
  const next = await secretField.inputValue();
  await expect(row).toContainText('The previous secret also signs until');
  await row.getByRole('button', { name: 'Test' }).click();
  const pings = async () => {
    const ctx = await playwright.request.newContext();
    const all = (await (
      await ctx.get(`${RECEIVER}/requests?path=${encodeURIComponent(path)}`)
    ).json()) as Received[];
    await ctx.dispose();
    return all.filter((r) => r.body.includes('"type":"ping"'));
  };
  await expect.poll(async () => (await pings()).length, { timeout: 30_000 }).toBe(1);
  const [ping] = await pings();
  const header = ping?.headers['x-openrows-signature'] ?? '';
  const ts = header.match(/^t=(\d+),/)?.[1] ?? '';
  const signatures = [...header.matchAll(/v1=([0-9a-f]{64})/g)].map((m) => m[1]);
  const sign = (key: string) =>
    createHmac('sha256', key).update(`${ts}.${ping?.body}`).digest('hex');
  expect(signatures).toEqual([sign(next), sign(secret)]);

  // Ending the grace period: only the new secret signs.
  await row.getByRole('button', { name: /^Stop using the previous secret/ }).click();
  await expect(row).not.toContainText('The previous secret also signs until');
});

test('redelivers a failed delivery from the log (#126)', async ({ page, playwright }) => {
  test.setTimeout(150_000);
  await signInDevUser(page);
  const api = stackApi(page);
  const ws = await api.post<{ id: string }>('/api/workspaces', { name: `Redeliver ${Date.now()}` });
  const base = await api.post<{ id: string }>(`/api/workspaces/${ws.id}/bases`, {
    name: 'Redelivered',
  });
  const table = await api.post<{ id: string; fields: { id: string; name: string }[] }>(
    `/api/bases/${base.id}/tables`,
    { name: 'Tasks' }
  );
  const notes = table.fields.find((f) => f.name === 'Notes');
  if (!notes) throw new Error('no Notes field');
  const record = await api.post<{ id: string }>(`/api/tables/${table.id}/records`, { fields: {} });
  const path = `/e2e-redeliver-${Date.now()}`;
  // The receiver answers 500 until the URL changes.
  const hook = await api.post<{ id: string }>(`/api/v1/bases/${base.id}/webhooks`, {
    url: `http://webhook-receiver:8190${path}-down?status=500`,
    events: ['record.updated'],
  });
  const res = await page.request.patch(`/api/tables/${table.id}/records`, {
    data: { records: [{ id: record.id, fields: { [notes.id]: 'Again' } }] },
    headers: { origin: api.origin },
  });
  expect(res.ok()).toBe(true);

  await page.goto(`/b/${base.id}/${table.id}`);
  await page.getByRole('button', { name: 'Switch base' }).click();
  await page.getByRole('menuitem', { name: 'Webhooks' }).click();
  const dialog = page.getByRole('dialog', { name: 'Webhooks' });
  const row = dialog.getByRole('listitem').filter({ hasText: path });
  await row.getByRole('button', { name: 'Delivery log' }).click();
  const failed = dialog
    .getByRole('list', { name: 'Deliveries' })
    .getByRole('listitem')
    .filter({ hasText: 'HTTP 500' })
    .last();
  await expect(failed).toBeVisible({ timeout: 90_000 });

  // The receiver is fixed: redeliver the failed event from the log.
  const fixed = await page.request.patch(`/api/v1/bases/${base.id}/webhooks/${hook.id}`, {
    data: { url: `http://webhook-receiver:8190${path}` },
    headers: { origin: api.origin },
  });
  expect(fixed.ok()).toBe(true);
  await failed.getByText('Records: Updated').click();
  const eventId = (await failed.locator('dd.font-mono').textContent()) ?? '';
  await failed.getByRole('button', { name: 'Redeliver' }).click();
  await expect(page.getByText('Redelivery queued')).toBeVisible();
  const received = async () => {
    const ctx = await playwright.request.newContext();
    const all = (await (
      await ctx.get(`${RECEIVER}/requests?path=${encodeURIComponent(path)}`)
    ).json()) as Received[];
    await ctx.dispose();
    return all.map((r) => r.headers['x-openrows-event-id']);
  };
  // The same event id as the failed attempts.
  await expect.poll(received, { timeout: 60_000 }).toContain(eventId);
  await expect(
    dialog.getByRole('list', { name: 'Deliveries' }).getByRole('listitem').first()
  ).toContainText('HTTP 200', { timeout: 30_000 });
});
