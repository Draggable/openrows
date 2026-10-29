import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// The workspace admin console against the mocked API, on /w/:id/admin: an owner sees the
// policies, SSO and SCIM at a glance and everyone with access; turns share links and tokens off
// and limits invitations to a domain; a bad domain is refused before saving. Off Enterprise the
// restrictions can only be lifted. Enforcement is the server's integration tests.

const PAGE = `/w/${IDS.workspace}/admin`;
const AT = '2026-10-29T10:00:00.000Z';
const BASE_ID = '01a18544-9433-7db5-b2be-37e989323f80';

interface Policies {
  shareLinks: boolean;
  publicForms: boolean;
  embeds: boolean;
  personalAccessTokens: boolean;
  inviteDomains: string[];
}

interface State {
  available: boolean;
  policies: Policies;
  saved: Policies[];
}

const DEFAULTS: Policies = {
  shareLinks: true,
  publicForms: true,
  embeds: true,
  personalAccessTokens: true,
  inviteDomains: [],
};

async function owner(page: Page, state: State) {
  await mockApi(page, { rows: 1 });
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });
  const policiesState = () => ({
    available: state.available,
    policies: state.policies,
    sso: { configured: true, enabled: true, requireSso: true },
    scim: { configured: false },
    updatedAt: state.saved.length ? AT : null,
  });
  await page.route(`**/api/workspaces/${IDS.workspace}`, (route) =>
    route.fulfill(
      json({ id: IDS.workspace, name: 'Ada', role: 'owner', createdAt: AT, updatedAt: AT })
    )
  );
  await page.route(`**/api/workspaces/${IDS.workspace}/policies`, (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      state.policies = req.postDataJSON() as Policies;
      state.saved.push(state.policies);
    }
    return route.fulfill(json(policiesState()));
  });
  await page.route(`**/api/workspaces/${IDS.workspace}/admin/members`, (route) =>
    route.fulfill(
      json({
        truncated: false,
        members: [
          {
            userId: '01a18544-9433-7db5-b2be-37e989323f01',
            name: 'Ada Lovelace',
            email: 'ada@acme.com',
            workspaceRole: 'owner',
            bases: [],
            baseCount: 0,
            interfaceCount: 0,
            lastActiveAt: new Date().toISOString(),
            provisioned: false,
          },
          {
            userId: '01a18544-9433-7db5-b2be-37e989323f02',
            name: 'Grace Hopper',
            email: 'grace@acme.com',
            workspaceRole: 'editor',
            bases: [],
            baseCount: 0,
            interfaceCount: 0,
            lastActiveAt: null,
            provisioned: true,
          },
          {
            userId: '01a18544-9433-7db5-b2be-37e989323f03',
            name: null,
            email: 'guest@partner.test',
            workspaceRole: null,
            bases: [{ id: BASE_ID, name: 'Roadmap', role: 'commenter' }],
            baseCount: 1,
            interfaceCount: 0,
            lastActiveAt: '2026-01-02T10:00:00.000Z',
            provisioned: false,
          },
        ],
      })
    )
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

test('an owner sets the workspace policies and sees everyone with access', async ({ page }) => {
  const state: State = { available: true, policies: { ...DEFAULTS }, saved: [] };
  await owner(page, state);
  await page.goto(PAGE);
  const policies = page.getByRole('region', { name: 'Policies' });
  await expect(policies.getByLabel('Allow public share links of views and bases')).toBeChecked();
  await expect(page.getByTestId('sso-status')).toHaveText(
    'On. Required for addresses on the verified domains.'
  );
  await expect(page.getByTestId('scim-status')).toHaveText('Not connected.');

  const people = page.getByRole('region', { name: 'People' });
  await expect(people.getByRole('row')).toHaveCount(4);
  await expect(people.getByRole('row', { name: /Grace Hopper/ })).toContainText('SCIM');
  await expect(people.getByRole('row', { name: /guest@partner.test/ })).toContainText(
    'Roadmap · Commenter'
  );
  await expect(people.getByRole('row', { name: /Ada Lovelace/ })).toContainText('Just now');
  await people.getByLabel('Find people').fill('grace');
  await expect(people.getByRole('row')).toHaveCount(2);
  await expectAxeClean(page);

  // A bad domain is refused before anything is sent.
  await policies.getByLabel('Allow public share links of views and bases').uncheck();
  await policies.getByLabel('Allow personal access tokens').uncheck();
  const domains = policies.getByLabel('Invitations only to these email domains');
  await domains.fill('acme.com\nlocalhost');
  await policies.getByRole('button', { name: 'Save policies' }).click();
  await expect(policies.getByRole('alert')).toHaveText(
    '"localhost" isn\'t a domain like example.com.'
  );
  expect(state.saved).toHaveLength(0);

  await domains.fill('ACME.com, @eu.acme.com');
  await policies.getByRole('button', { name: 'Save policies' }).click();
  await expect.poll(() => state.saved.length).toBe(1);
  expect(state.saved[0]).toEqual({
    shareLinks: false,
    publicForms: true,
    embeds: true,
    personalAccessTokens: false,
    inviteDomains: ['acme.com', 'eu.acme.com'],
  });
  await expect(domains).toHaveValue('acme.com\neu.acme.com');
  await expect(policies.getByRole('button', { name: 'Save policies' })).toBeDisabled();
  await expectAxeClean(page);
});

test('off Enterprise, restrictions can only be lifted and the people list is hidden', async ({
  page,
}) => {
  const state: State = {
    available: false,
    policies: { ...DEFAULTS, embeds: false },
    saved: [],
  };
  await owner(page, state);
  await page.goto(PAGE);
  await expect(page.getByText(/The admin console is part of the Enterprise plan/)).toBeVisible();
  const policies = page.getByRole('region', { name: 'Policies' });
  // On switches can't be turned off; the restricted one can be turned back on.
  await expect(policies.getByLabel('Allow public forms')).toBeDisabled();
  const embeds = policies.getByLabel('Allow embedding share links on other sites');
  await expect(embeds).toBeEnabled();
  await embeds.check();
  await policies.getByRole('button', { name: 'Save policies' }).click();
  await expect.poll(() => state.saved.length).toBe(1);
  expect(state.saved[0]).toEqual(DEFAULTS);
  await expect(page.getByRole('region', { name: 'People' })).toHaveCount(0);
});
