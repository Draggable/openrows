import AxeBuilder from '@axe-core/playwright';
import type { Page, Route } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The hosted ops console against the mocked API: a system admin's /admin (workspaces with
// plan, usage, members, tokens and webhooks; suspending one with a reason; the audit log), the
// fresh sign-in prompt, read-only impersonation with its banner and the way back, the user's
// "Support access" in Settings, and what non-admins see. Needs only the built client.

const ADMIN_ID = '00000000-0000-7000-8000-00000000a001';
const USER_ID = '00000000-0000-7000-8000-00000000a002';
const TOKEN_ID = '00000000-0000-7000-8000-00000000a003';
const WEBHOOK_ID = '00000000-0000-7000-8000-00000000a004';
const NOW = '2026-10-28T10:00:00.000Z';

const workspace = (suspended: boolean) => ({
  id: IDS.workspace,
  name: 'Acme Inc',
  plan: 'pro',
  createdAt: '2026-09-01T10:00:00.000Z',
  lastActiveAt: NOW,
  members: 2,
  records: 1234,
  suspendedAt: suspended ? NOW : null,
  suspendedReason: suspended ? 'Abuse report 7' : null,
  deletedAt: null,
});

const usage = {
  workspaceId: IDS.workspace,
  plan: { id: 'pro', name: 'Pro' },
  period: { start: '2026-10-01', end: '2026-11-01' },
  bases: [{ baseId: IDS.base, name: 'Roadmap', records: 1234, limit: 100000 }],
  attachmentBytes: { used: 0, limit: null },
  automationRuns: { used: 12, limit: 25000 },
  apiCalls: { used: 340, limit: 100000 },
  editors: { used: 2, limit: null },
  aiCredits: null,
  revisionHistoryDays: 365,
  features: {
    removeBranding: true,
    personalViews: true,
    lockedViews: true,
    editPermissions: true,
    sso: false,
    scim: false,
    auditLogExport: false,
    adminConsole: false,
    dataResidency: false,
  },
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });

const problem = (status: number, code: string) => ({
  type: 'about:blank',
  title: code,
  status,
  code,
  requestId: 'e2e',
});

interface State {
  admin: boolean;
  suspended: boolean;
  impersonating: boolean;
  audit: { action: string; targetWorkspaceId?: string; targetUserId?: string }[];
  calls: { method: string; path: string; body: unknown }[];
  /** The console answers 403 REAUTHENTICATION_REQUIRED. */
  stale?: boolean;
}

async function setup(page: Page, init: Partial<State> = {}): Promise<State> {
  const state: State = {
    admin: true,
    suspended: false,
    impersonating: false,
    audit: [],
    calls: [],
    ...init,
  };
  await mockApi(page, { rows: 1 });
  await page.route('**/api/me', (route) =>
    json(route, {
      user: state.impersonating
        ? {
            id: USER_ID,
            email: 'grace@example.test',
            name: 'Grace',
            avatarUrl: null,
            isSystemAdmin: false,
          }
        : {
            id: ADMIN_ID,
            email: 'ops@openrows.test',
            name: 'Ops',
            avatarUrl: null,
            isSystemAdmin: state.admin,
          },
      session: { createdAt: NOW, expiresAt: '2026-11-24T10:00:00.000Z', authenticatedAt: NOW },
      impersonation: state.impersonating
        ? {
            adminEmail: 'ops@openrows.test',
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          }
        : null,
    })
  );
  await page.route('**/api/me/impersonation', (route) => {
    state.impersonating = false;
    state.audit.unshift({ action: 'impersonation.end', targetUserId: USER_ID });
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/me/support-access', (route) =>
    json(route, {
      entries: [{ startedAt: NOW, expiresAt: '2026-10-28T10:15:00.000Z', reason: 'Ticket 42' }],
    })
  );
  await page.route('**/api/admin/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (!state.admin || state.impersonating) {
      return json(route, problem(404, 'NOT_FOUND'), 404);
    }
    if (state.stale) {
      return json(route, problem(403, 'REAUTHENTICATION_REQUIRED'), 403);
    }
    state.calls.push({ method, path, body: request.postDataJSON() });
    if (path === '/api/admin/workspaces') {
      state.audit.unshift({ action: 'workspaces.list' });
      return json(route, { workspaces: [workspace(state.suspended)], total: 1 });
    }
    if (path === `/api/admin/workspaces/${IDS.workspace}`) {
      state.audit.unshift({ action: 'workspace.view', targetWorkspaceId: IDS.workspace });
      return json(route, {
        workspace: { ...workspace(state.suspended), planOverrides: {} },
        usage,
        members: [
          { userId: ADMIN_ID, email: 'owner@acme.test', name: 'Owner', role: 'owner' },
          { userId: USER_ID, email: 'grace@example.test', name: 'Grace', role: 'editor' },
        ],
        tokens: [
          {
            id: TOKEN_ID,
            userId: USER_ID,
            userEmail: 'grace@example.test',
            name: 'CI sync',
            scopes: ['data.records:read'],
            createdAt: NOW,
            expiresAt: '2027-01-01T00:00:00.000Z',
            lastUsedAt: NOW,
            revokedAt: null,
          },
        ],
        webhooks: [
          {
            id: WEBHOOK_ID,
            baseId: IDS.base,
            baseName: 'Roadmap',
            host: 'hooks.example.test',
            enabled: true,
            createdBy: ADMIN_ID,
            createdAt: NOW,
            lastDeliveryAt: null,
          },
        ],
      });
    }
    if (path === `/api/admin/workspaces/${IDS.workspace}/suspension` && method === 'PUT') {
      const body = request.postDataJSON() as { suspended: boolean };
      state.suspended = body.suspended;
      state.audit.unshift({
        action: body.suspended ? 'workspace.suspend' : 'workspace.unsuspend',
        targetWorkspaceId: IDS.workspace,
      });
      return route.fulfill({ status: 204 });
    }
    if (path === '/api/admin/users') {
      return json(route, {
        users: [
          {
            id: USER_ID,
            email: 'grace@example.test',
            name: 'Grace',
            createdAt: '2026-09-02T10:00:00.000Z',
            lastActiveAt: NOW,
            workspaces: 1,
            isSystemAdmin: false,
            suspendedAt: null,
            suspendedReason: null,
            deletedAt: null,
          },
        ],
        total: 1,
      });
    }
    if (path === `/api/admin/users/${USER_ID}`) {
      return json(route, {
        user: {
          id: USER_ID,
          email: 'grace@example.test',
          name: 'Grace',
          createdAt: '2026-09-02T10:00:00.000Z',
          lastActiveAt: NOW,
          workspaces: 1,
          isSystemAdmin: false,
          suspendedAt: null,
          suspendedReason: null,
          deletedAt: null,
        },
        memberships: [{ workspaceId: IDS.workspace, workspaceName: 'Acme Inc', role: 'editor' }],
        tokens: [],
      });
    }
    if (path === `/api/admin/users/${USER_ID}/impersonation` && method === 'POST') {
      state.impersonating = true;
      state.audit.unshift({ action: 'impersonation.start', targetUserId: USER_ID });
      return json(
        route,
        { userId: USER_ID, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() },
        201
      );
    }
    if (path === '/api/admin/audit') {
      return json(route, {
        entries: state.audit.map((e, i) => ({
          id: `00000000-0000-7000-8000-${String(900000000000 - i).padStart(12, '0')}`,
          adminId: ADMIN_ID,
          adminEmail: 'ops@openrows.test',
          action: e.action,
          targetUserId: e.targetUserId ?? null,
          targetWorkspaceId: e.targetWorkspaceId ?? null,
          detail: {},
          createdAt: NOW,
        })),
        nextBefore: null,
      });
    }
    return json(route, problem(404, 'NOT_FOUND'), 404);
  });
  return state;
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('a system admin reviews a workspace, suspends it with a reason, and sees the audit log', async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Ops console' }).click();
  await expect(page).toHaveURL('/admin');
  await expect(page.getByRole('heading', { name: 'Ops console' })).toBeVisible();
  await page.getByRole('button', { name: 'Acme Inc' }).click();
  const detail = page.getByTestId('admin-workspace-detail');
  await expect(detail.getByRole('heading', { name: 'Acme Inc' })).toBeVisible();
  await expect(detail).toContainText('hooks.example.test');
  await expect(detail).toContainText('CI sync');
  await expect(detail).toContainText('1,234');
  await expectAxeClean(page);

  await detail.getByRole('button', { name: 'Suspend' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Suspend workspace' })).toBeDisabled();
  await dialog.getByLabel('Reason').fill('Abuse report 7');
  await dialog.getByRole('button', { name: 'Suspend workspace' }).click();
  await expect(detail.getByText('Abuse report 7')).toBeVisible();
  expect(state.calls).toContainEqual({
    method: 'PUT',
    path: `/api/admin/workspaces/${IDS.workspace}/suspension`,
    body: { suspended: true, reason: 'Abuse report 7' },
  });

  await page.getByRole('tab', { name: 'Audit log' }).click();
  const audit = page.getByTestId('admin-audit');
  await expect(audit).toContainText('Suspended workspace');
  await expect(audit).toContainText('Viewed workspace');
});

test('impersonation is read-only with a banner, and Stop returns to the console', async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Users' }).click();
  await page.getByRole('button', { name: 'grace@example.test' }).click();
  await page.getByTestId('admin-user-detail').getByRole('button', { name: 'Impersonate' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Ticket 42');
  await page.getByRole('dialog').getByRole('button', { name: 'Impersonate' }).click();

  const banner = page.getByTestId('impersonation-banner');
  await expect(banner).toContainText('Viewing as grace@example.test');
  await expect(banner).toContainText('read-only');
  await expect(page).toHaveURL('/');
  // The impersonated user has no console link.
  await expect(page.getByRole('link', { name: 'Ops console' })).toHaveCount(0);
  await expectAxeClean(page);

  await banner.getByRole('button', { name: 'Stop impersonating' }).click();
  await expect(page).toHaveURL('/admin');
  await expect(page.getByTestId('impersonation-banner')).toHaveCount(0);
  expect(state.impersonating).toBe(false);
  expect(state.audit.map((e) => e.action)).toEqual(
    expect.arrayContaining(['impersonation.start', 'impersonation.end'])
  );
});

test('the console asks for a fresh sign-in, and is not there for anyone else', async ({ page }) => {
  const state = await setup(page, { stale: true });
  await page.goto('/admin');
  const blocked = page.getByTestId('admin-blocked');
  await expect(blocked.getByRole('heading', { name: 'Sign in again' })).toBeVisible();

  state.admin = false;
  state.stale = false;
  await page.goto('/settings');
  await expect(page.getByRole('link', { name: 'Ops console' })).toHaveCount(0);
  // The user's account activity: when staff viewed the account as them.
  await expect(page.getByTestId('support-access')).toContainText('Ticket 42');
  await page.goto('/admin');
  await expect(blocked.getByRole('heading', { name: 'No ops console here' })).toBeVisible();
});
