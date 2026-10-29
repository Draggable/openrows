import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The workspace audit log against the mocked API: an owner on the Enterprise plan opens it
// from the workspace menu, filters the entries, exports what the filters show and sets up the
// SIEM stream; on another plan the page says what it needs. Needs only the built client.

const PAGE = `/w/${IDS.workspace}/audit-log`;
const AT = '2026-10-28T10:00:00.000Z';

const EVENTS = [
  {
    id: '01a18544-9433-7db5-b2be-37e989323f81',
    at: AT,
    action: 'member.role_change',
    actor: { kind: 'user', userId: IDS.workspace, email: 'ada@example.test' },
    ip: '203.0.113.9',
    userAgent: 'Firefox',
    target: { type: 'user', id: null, name: 'bob@example.test' },
    summary: { before: { role: 'editor' }, after: { role: 'creator' } },
  },
  {
    id: '01a18544-9433-7db5-b2be-37e989323f80',
    at: AT,
    action: 'auth.sign_in',
    actor: { kind: 'user', userId: IDS.workspace, email: 'ada@example.test' },
    ip: '203.0.113.9',
    userAgent: 'Firefox',
    target: { type: 'user', id: null, name: 'ada@example.test' },
    summary: { after: { method: 'oidc' } },
  },
];

interface State {
  plan: 'enterprise' | 'free';
  stream: Record<string, unknown> | null;
  queries: string[];
}

async function owner(page: Page, state: State) {
  await mockApi(page, { rows: 1 });
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });
  await page.route(`**/api/workspaces/${IDS.workspace}`, (route) =>
    route.fulfill(
      json({ id: IDS.workspace, name: 'Ada', role: 'owner', createdAt: AT, updatedAt: AT })
    )
  );
  const refused = () =>
    json(
      {
        type: 'about:blank',
        title: 'Plan feature required',
        status: 403,
        code: 'PLAN_FEATURE_REQUIRED',
        detail: "Audit log: not included in this workspace's plan.",
        requestId: 'e2e',
      },
      403
    );
  await page.route(
    (url) => url.pathname === `/api/workspaces/${IDS.workspace}/audit-log`,
    (route) => {
      if (state.plan !== 'enterprise') return route.fulfill(refused());
      const url = new URL(route.request().url());
      state.queries.push(url.search);
      const action = url.searchParams.get('action');
      const events = EVENTS.filter((e) => !action || e.action.startsWith(`${action}.`));
      return route.fulfill(json({ events, nextBefore: null, retentionDays: 365 }));
    }
  );
  await page.route(`**/api/workspaces/${IDS.workspace}/audit-log/stream`, (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as { url: string; enabled?: boolean };
      const created = state.stream === null;
      state.stream = {
        url: body.url,
        enabled: body.enabled ?? true,
        lastDeliveryAt: null,
        lastError: null,
        failures: 0,
        createdAt: AT,
      };
      return route.fulfill(json({ stream: state.stream, secret: created ? 'whsec_e2e' : null }));
    }
    if (method === 'DELETE') {
      state.stream = null;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill(json({ stream: state.stream }));
  });
}

async function expectAxeClean(page: Page) {
  // The page, not its toasts: sonner fades the ones stacked behind the newest, which axe then
  // reads as low contrast depending on timing (flaky on CI's stack).
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('an Enterprise owner filters the audit log, exports it and streams it', async ({ page }) => {
  const state: State = { plan: 'enterprise', stream: null, queries: [] };
  await owner(page, state);
  await page.goto(`/w/${IDS.workspace}`);
  await page.getByRole('button', { name: /^Workspace: / }).click();
  await page.getByRole('menuitem', { name: 'Audit log' }).click();
  await expect(page).toHaveURL(PAGE);
  await expect(page.getByRole('heading', { name: 'Ada · Audit log' })).toBeVisible();

  const table = page.getByRole('table', { name: 'Audit log, newest first' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(1)).toContainText("Changed a member's role");
  await expect(table.getByRole('row').nth(1)).toContainText('role: editor → creator');
  await expect(table.getByRole('row').nth(2)).toContainText('Signed in');
  await expect(page.getByText('Entries are kept for 365 days.')).toBeVisible();
  await expectAxeClean(page);

  await page.getByLabel('Activity').selectOption({ label: 'Sign-ins' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row').nth(1)).toContainText('Signed in');
  expect(state.queries.at(-1)).toContain('action=auth');
  await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveAttribute(
    'href',
    /\/audit-log\/export\?.*action=auth.*format=csv/
  );
  await expect(page.getByRole('link', { name: 'Export JSON' })).toHaveAttribute(
    'href',
    /format=json/
  );

  await page.getByLabel('Endpoint URL').fill('https://siem.example.test/ingest');
  await page.getByRole('button', { name: 'Start streaming' }).click();
  await expect(page.getByTestId('audit-stream-secret')).toHaveText('whsec_e2e');
  await expect(page.getByTestId('audit-stream-state')).toHaveText('On. Nothing sent yet.');
  await page.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByTestId('audit-stream-state')).toHaveText('Off.');
  await expectAxeClean(page);
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('audit-stream-state')).toHaveCount(0);
});

test('on a plan without the audit log, the page says it is part of Enterprise', async ({
  page,
}) => {
  await owner(page, { plan: 'free', stream: null, queries: [] });
  await page.goto(PAGE);
  await expect(page.getByText(/The audit log is part of the Enterprise plan/)).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});
