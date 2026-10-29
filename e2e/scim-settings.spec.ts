import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// SCIM provisioning's settings against the mocked API, under single sign-on on
// /w/:id/sso: an owner generates the token (shown once), maps a pushed group to a role, changes
// the default role, rotates and revokes the token; other plans are told what they need. The
// /scim/v2 protocol itself is the hosted edition's integration test.

const PAGE = `/w/${IDS.workspace}/sso`;
const AT = '2026-10-29T10:00:00.000Z';
const REALM = 'http://localhost:8080/realms/openrows';
const ALIAS = `ws-${IDS.workspace}`;
const GROUP_ID = '01a18544-9433-7db5-b2be-37e989323f91';
const TOKEN = `or_scim_${'A'.repeat(39)}Wxyz`;

interface State {
  plan: 'enterprise' | 'pro';
  token: { hint: string; createdAt: string; lastUsedAt: string | null } | null;
  defaultRole: string;
  groupRole: string | null;
  requests: { method: string; path: string; body: unknown }[];
}

async function owner(page: Page, state: State) {
  await mockApi(page, { rows: 1 });
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });
  const forbidden = (what: string) =>
    json(
      {
        type: 'about:blank',
        title: 'Plan feature required',
        status: 403,
        code: 'PLAN_FEATURE_REQUIRED',
        detail: `${what}: not included in this workspace's plan.`,
        requestId: 'e2e',
      },
      403
    );
  const group = () => ({
    id: GROUP_ID,
    displayName: 'Engineering',
    externalId: 'okta-1',
    role: state.groupRole,
    members: 12,
  });
  const scimState = () => ({
    baseUrl: 'http://localhost:4173/scim/v2',
    token: state.token,
    defaultRole: state.defaultRole,
    verifiedDomains: ['acme.com'],
    users: { total: 14, active: 13, linked: 12 },
    groups: [group()],
  });
  await page.route(`**/api/workspaces/${IDS.workspace}`, (route) =>
    route.fulfill(
      json({ id: IDS.workspace, name: 'Ada', role: 'owner', createdAt: AT, updatedAt: AT })
    )
  );
  await page.route(`**/api/workspaces/${IDS.workspace}/sso`, (route) =>
    state.plan === 'pro'
      ? route.fulfill(forbidden('Single sign-on'))
      : route.fulfill(
          json({
            available: true,
            connection: null,
            domains: [
              {
                id: '01a18544-9433-7db5-b2be-37e989323f90',
                domain: 'acme.com',
                verifiedAt: AT,
                lastCheckedAt: AT,
                txtName: '_openrows-verification.acme.com',
                txtValue: 'openrows-verification=0123456789abcdef0123456789abcdef',
              },
            ],
            serviceProvider: {
              redirectUri: `${REALM}/broker/${ALIAS}/endpoint`,
              entityId: REALM,
              acsUrl: `${REALM}/broker/${ALIAS}/endpoint`,
              metadataUrl: `${REALM}/broker/${ALIAS}/endpoint/descriptor`,
            },
          })
        )
  );
  await page.route(
    (url) => url.pathname.startsWith(`/api/workspaces/${IDS.workspace}/scim`),
    (route) => {
      if (state.plan !== 'enterprise') return route.fulfill(forbidden('SCIM provisioning'));
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const method = req.method();
      if (method !== 'GET') state.requests.push({ method, path, body: req.postDataJSON() });
      if (path.endsWith('/scim/token') && method === 'POST') {
        state.token = { hint: TOKEN.slice(-4), createdAt: AT, lastUsedAt: null };
        return route.fulfill(json({ token: TOKEN, state: scimState() }, 201));
      }
      if (path.endsWith('/scim/token') && method === 'DELETE') {
        state.token = null;
        return route.fulfill({ status: 204 });
      }
      if (path.endsWith(`/groups/${GROUP_ID}`)) {
        state.groupRole = (req.postDataJSON() as { role: string | null }).role;
        return route.fulfill(json(group()));
      }
      if (method === 'PATCH') {
        state.defaultRole = (req.postDataJSON() as { defaultRole: string }).defaultRole;
      }
      return route.fulfill(json(scimState()));
    }
  );
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    // sonner's toasts fade out while the scan runs.
    .exclude('[data-sonner-toaster]')
    .analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('an owner sets up SCIM: the token once, group roles, the default role', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const state: State = {
    plan: 'enterprise',
    token: null,
    defaultRole: 'editor',
    groupRole: null,
    requests: [],
  };
  await owner(page, state);
  await page.goto(PAGE);
  const panel = page.getByRole('region', { name: 'SCIM provisioning' });
  await expect(panel).toContainText('http://localhost:4173/scim/v2');
  await expect(panel).toContainText("No token: the identity provider can't connect.");
  await expect(panel.getByTestId('scim-users')).toHaveText(
    '14 people provisioned, 12 in the workspace, 1 joining at their first sign-in, 1 deactivated.'
  );
  await expectAxeClean(page);

  // The token, shown once.
  await panel.getByRole('button', { name: 'Generate token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy your SCIM token' });
  await expect(dialog.getByLabel('SCIM token')).toHaveValue(TOKEN);
  await expectAxeClean(page);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByTestId('scim-token')).toHaveText(
    /^Token ending in Wxyz, created .+, last used never\.$/
  );
  await expect(page.getByText(TOKEN)).toHaveCount(0);

  // A pushed group mapped to a role, and the default role.
  await panel.getByLabel('Engineering').selectOption({ label: 'Creator' });
  await expect.poll(() => state.groupRole).toBe('creator');
  await panel.getByLabel('Role for people in no mapped group').selectOption({ label: 'Commenter' });
  await expect.poll(() => state.defaultRole).toBe('commenter');
  await expect(panel.getByLabel('Role for people in no mapped group')).toHaveValue('commenter');

  // Rotating shows the new token again; revoking asks first.
  await panel.getByRole('button', { name: 'Rotate token' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await panel.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke token' }).click();
  await expect(panel.getByRole('button', { name: 'Generate token' })).toBeVisible();
  expect(state.requests.map((r) => `${r.method} ${r.path.split('/scim')[1]}`)).toEqual([
    'POST /token',
    `PATCH /groups/${GROUP_ID}`,
    'PATCH ',
    'POST /token',
    'DELETE /token',
  ]);
  expect(state.requests[1]?.body).toEqual({ role: 'creator' });
});

test('on a plan without SCIM, the settings say which plans have it', async ({ page }) => {
  await owner(page, {
    plan: 'pro',
    token: null,
    defaultRole: 'editor',
    groupRole: null,
    requests: [],
  });
  await page.goto(PAGE);
  await expect(
    page.getByText(/Provisioning people and groups from your identity provider with SCIM/)
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate token' })).toHaveCount(0);
});
