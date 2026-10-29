import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { latestMessageTo } from './auth/mailpit.js';
import { signInDevUser, signUp } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Presence against the whole Compose stack (E2E_STACK=1): two people, the dev user (A)
// and a collaborator who signs up and accepts an invitation (B), on the same grid view. B sees
// A's avatar in the top bar, A's selected cell (outside the cell's text), "editing…" while
// A's editor is open and A in the record view's header; all of it is gone within 5 s of A
// leaving.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Table = { id: string; baseId: string; fields: { id: string; name: string }[] };

async function post<T>(request: APIRequestContext, origin: string, path: string, data: unknown) {
  const res = await request.post(path, { data, headers: { origin } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

const gridCell = (page: Page, row: number, col: number) =>
  page.getByRole('grid').locator(`[data-cell="${row}:${col}"]`);

async function newPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const seen = await watchCsp(context, new URL(baseURL ?? 'http://localhost').origin);
  return { context, page: await context.newPage(), seen };
}

test('B sees A on the view and on A’s selected cell, until A leaves', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const a = await newPage(browser, baseURL);
  const b = await newPage(browser, baseURL);
  try {
    // A: a workspace with a table and a record, and an invitation for B.
    await signInDevUser(a.page);
    const origin = new URL(a.page.url()).origin;
    const me = (await (await a.page.request.get('/api/me')).json()) as { user: { id: string } };
    const workspace = await post<{ id: string }>(a.page.request, origin, '/api/workspaces', {
      name: `Presence ${Date.now()}`,
    });
    const base = await post<{ id: string }>(
      a.page.request,
      origin,
      `/api/workspaces/${workspace.id}/bases`,
      { name: 'Together' }
    );
    const table = await post<Table>(a.page.request, origin, `/api/bases/${base.id}/tables`, {
      name: 'Tasks',
    });
    const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
    const record = await post<{ id: string }>(
      a.page.request,
      origin,
      `/api/tables/${table.id}/records`,
      { fields: { [name]: 'Shared' } }
    );
    const invitee = {
      email: `presence-${Date.now()}@openrows.test`,
      firstName: 'Bea',
      lastName: 'Presence',
      password: 'presence-e2e-password',
    };
    await post(a.page.request, origin, `/api/workspaces/${workspace.id}/invitations`, {
      email: invitee.email,
      role: 'editor',
    });
    const link = (await latestMessageTo(invitee.email)).match(
      /https?:\/\/\S+\/invite\/[A-Za-z0-9_-]+/
    )?.[0];
    expect(link, 'invitation link in the email').toBeTruthy();

    // B signs up and accepts.
    await signUp(b.page, invitee);
    await b.page.goto(new URL(link ?? '').pathname);
    await b.page.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(b.page).not.toHaveURL(/\/invite\//);

    // Both open the grid.
    await a.page.goto(`/b/${base.id}/${table.id}`);
    await expect(gridCell(a.page, 0, 0)).toHaveText('Shared');
    const url = new URL(a.page.url()).pathname;
    await b.page.goto(url);
    await expect(gridCell(b.page, 0, 0)).toHaveText('Shared');

    // B sees A's avatar in the top bar (and A sees B's).
    const avatarOfA = b.page.getByTestId('presence').locator(`[data-user="${me.user.id}"]`);
    await expect(avatarOfA).toBeVisible();
    await expect(b.page.getByRole('list', { name: /^Also viewing: Dev User$/ })).toBeVisible();
    await expect(a.page.getByRole('list', { name: /^Also viewing: Bea Presence$/ })).toBeVisible();

    // Both open the record: B's record view names A.
    await a.page.goto(`${url}?record=${record.id}`);
    await expect(a.page.getByTestId('record-expand')).toBeVisible();
    await b.page.goto(`${url}?record=${record.id}`);
    await expect(
      b.page.getByTestId('record-expand').getByRole('list', { name: 'Also here: Dev User' })
    ).toBeVisible();
    // Back to the grid.
    for (const p of [a.page, b.page]) {
      await p.goto(url);
      await expect(gridCell(p, 0, 0)).toHaveText('Shared');
    }

    // A selects a cell: B sees the outline there, with A's initials on hover.
    await gridCell(a.page, 0, 0).click();
    const marker = gridCell(b.page, 0, 0).getByTestId('peer-cell');
    await expect(marker).toHaveAttribute('data-peer', me.user.id);
    await gridCell(b.page, 0, 1).hover();
    await gridCell(b.page, 0, 0).hover();
    const label = marker.getByTestId('peer-cell-label');
    await expect(label).toHaveAttribute('data-label', 'DU');
    await expect(label).toBeVisible();
    // The initials are a pseudo-element: the cell's text and name stay the value.
    await expect(gridCell(b.page, 0, 0)).toHaveText('Shared');
    await expect(gridCell(b.page, 0, 0)).toHaveAccessibleName('Shared');
    await expect(gridCell(b.page, 0, 0)).toHaveAccessibleDescription('Dev User is here');
    // A opens the editor: "editing…"; Escape closes it.
    await a.page.keyboard.press('Enter');
    await expect(marker).toHaveAttribute('data-editing', 'true');
    await expect(label).toHaveAttribute('data-label', 'DU editing…');
    await expect(gridCell(b.page, 0, 0)).toHaveText('Shared');
    await expect(gridCell(b.page, 0, 0)).toHaveAccessibleDescription('Dev User is editing');
    await a.page.keyboard.press('Escape');
    await expect(marker).not.toHaveAttribute('data-editing', 'true');
    // A moves on: the marker follows.
    await a.page.keyboard.press('ArrowRight');
    await expect(gridCell(b.page, 0, 1).getByTestId('peer-cell')).toBeVisible();
    await expect(gridCell(b.page, 0, 0).getByTestId('peer-cell')).toHaveCount(0);

    // The avatars and the marked row (the grid as a whole has a known axe finding: a button
    // directly in role=grid, aria-required-children, not from presence).
    const axe = await new AxeBuilder({ page: b.page })
      .include('header')
      .include('[role="row"]:has([data-testid="peer-cell"])')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      axe.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .map((v) => v.id)
    ).toEqual([]);

    // A leaves: within 5 s B no longer shows A's avatar or selected cell.
    await expect(avatarOfA).toBeVisible();
    await a.context.close();
    await expect(avatarOfA).toHaveCount(0, { timeout: 5000 });
    await expect(b.page.getByTestId('peer-cell')).toHaveCount(0, { timeout: 5000 });
    await expect(b.page.getByTestId('presence')).toHaveCount(0);
    expect(a.seen).toEqual([]);
    expect(b.seen).toEqual([]);
  } finally {
    await a.context.close().catch(() => {});
    await b.context.close();
  }
});
