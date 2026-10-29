import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Per-workspace single sign-on against the mocked API: an owner opens it from the
// workspace menu, connects an OIDC provider, adds a domain and verifies it; on a plan without it
// the page says what it needs; and the sign-in page's "Sign in with SSO" goes to /auth/login
// with the address. Needs only the built client. The Keycloak flow itself is e2e/sso.spec.ts's.

const PAGE = `/w/${IDS.workspace}/sso`;
const AT = '2026-10-29T10:00:00.000Z';
const REALM = 'http://localhost:8080/realms/openrows';
const ALIAS = `ws-${IDS.workspace}`;
const DOMAIN_ID = '01a18544-9433-7db5-b2be-37e989323f90';

interface State {
  plan: 'business' | 'free';
  connection: Record<string, unknown> | null;
  domains: Record<string, unknown>[];
  puts: unknown[];
}

async function owner(page: Page, state: State) {
  await mockApi(page, { rows: 1 });
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });
  const ssoState = () => ({
    available: true,
    connection: state.connection,
    domains: state.domains,
    serviceProvider: {
      redirectUri: `${REALM}/broker/${ALIAS}/endpoint`,
      entityId: REALM,
      acsUrl: `${REALM}/broker/${ALIAS}/endpoint`,
      metadataUrl: `${REALM}/broker/${ALIAS}/endpoint/descriptor`,
    },
  });
  await page.route(`**/api/workspaces/${IDS.workspace}`, (route) =>
    route.fulfill(
      json({ id: IDS.workspace, name: 'Ada', role: 'owner', createdAt: AT, updatedAt: AT })
    )
  );
  await page.route(
    (url) => url.pathname.startsWith(`/api/workspaces/${IDS.workspace}/sso`),
    (route) => {
      if (state.plan !== 'business') {
        return route.fulfill(
          json(
            {
              type: 'about:blank',
              title: 'Plan feature required',
              status: 403,
              code: 'PLAN_FEATURE_REQUIRED',
              detail: "Single sign-on: not included in this workspace's plan.",
              requestId: 'e2e',
            },
            403
          )
        );
      }
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (path.endsWith('/sso') && req.method() === 'PUT') {
        const body = req.postDataJSON() as Record<string, unknown> & {
          oidc: { issuer: string; clientId: string };
        };
        state.puts.push(body);
        state.connection = {
          alias: ALIAS,
          protocol: 'oidc',
          displayName: body['displayName'],
          enabled: body['enabled'],
          requireSso: body['requireSso'],
          jit: body['jit'],
          defaultRole: body['defaultRole'],
          oidc: { issuer: body.oidc.issuer, clientId: body.oidc.clientId },
          saml: null,
          createdAt: AT,
          updatedAt: AT,
        };
        return route.fulfill(json(ssoState()));
      }
      if (path.endsWith('/sso/domains') && req.method() === 'POST') {
        const { domain } = req.postDataJSON() as { domain: string };
        const d = {
          id: DOMAIN_ID,
          domain,
          verifiedAt: null,
          lastCheckedAt: null,
          txtName: `_openrows-verification.${domain}`,
          txtValue: 'openrows-verification=0123456789abcdef0123456789abcdef',
        };
        state.domains = [d];
        return route.fulfill(json(d, 201));
      }
      if (path.endsWith('/verify')) {
        const d = { ...state.domains[0], verifiedAt: AT, lastCheckedAt: AT };
        state.domains = [d];
        return route.fulfill(json(d));
      }
      return route.fulfill(json(ssoState()));
    }
  );
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
      .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))
  ).toEqual([]);
}

test('an owner connects an OIDC provider and verifies a domain', async ({ page }) => {
  const state: State = { plan: 'business', connection: null, domains: [], puts: [] };
  await owner(page, state);
  await page.goto(`/w/${IDS.workspace}`);
  await page.getByRole('button', { name: /^Workspace: / }).click();
  await page.getByRole('menuitem', { name: 'Single sign-on' }).click();
  await expect(page).toHaveURL(PAGE);
  await expect(page.getByRole('heading', { name: 'Ada · Single sign-on' })).toBeVisible();
  await expect(page.getByTestId('sso-sp')).toContainText(`${REALM}/broker/${ALIAS}/endpoint`);
  await page.getByText('SAML 2.0', { exact: true }).click();
  await expect(page.getByTestId('sso-sp')).toContainText('ACS URL');
  await expect(page.getByTestId('sso-sp')).toContainText(`${ALIAS}/endpoint/descriptor`);
  await page.getByText('OpenID Connect', { exact: true }).click();
  await expectAxeClean(page);

  await page.getByLabel('Name').fill('Acme Okta');
  await page.getByLabel('Issuer URL').fill('https://acme.okta.com');
  await page.getByLabel('Client ID').fill('0oa1');
  await page.getByLabel('Client secret').fill('s3cret');
  await page.getByLabel('Require single sign-on').check();
  await page.getByLabel('as', { exact: true }).selectOption({ label: 'Commenter' });
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  expect(state.puts.at(-1)).toEqual({
    protocol: 'oidc',
    displayName: 'Acme Okta',
    enabled: true,
    requireSso: true,
    jit: true,
    defaultRole: 'commenter',
    oidc: { issuer: 'https://acme.okta.com', clientId: '0oa1', clientSecret: 's3cret' },
  });
  // The secret is write-only: the field is empty again.
  await expect(page.getByLabel('Client secret')).toHaveValue('');

  await page.getByLabel('Domain', { exact: true }).fill('acme.com');
  await page.getByRole('button', { name: 'Add domain' }).click();
  const row = page.getByTestId('sso-domain');
  await expect(row).toContainText('Not verified');
  await expect(row).toContainText('_openrows-verification.acme.com');
  await expect(row).toContainText('openrows-verification=0123456789abcdef0123456789abcdef');
  await expectAxeClean(page);
  await row.getByRole('button', { name: 'Verify' }).click();
  await expect(row).toContainText('Verified');
  await expect(row.getByRole('button', { name: 'Verify' })).toHaveCount(0);
});

test('on a plan without single sign-on, the page says which plans have it', async ({ page }) => {
  await owner(page, { plan: 'free', connection: null, domains: [], puts: [] });
  await page.goto(PAGE);
  await expect(page.getByText(/part of the Business and Enterprise plans/)).toBeVisible();
  await expect(page.getByLabel('Issuer URL')).toHaveCount(0);
});

test('"Sign in with SSO" sends the address to the server’s sign-in', async ({ page }) => {
  await page.goto('/login?error=sso_required');
  await expect(page.getByRole('alert')).toContainText('requires single sign-on');
  await expectAxeClean(page);
  let asked: URL | undefined;
  await page.route('**/auth/login?*', (route) => {
    asked = new URL(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/plain', body: 'to the IdP' });
  });
  await page.getByLabel('Work email').fill('ada@acme.com');
  await page.getByRole('button', { name: 'Continue with SSO' }).click();
  await expect(page.getByText('to the IdP')).toBeVisible();
  expect(asked?.searchParams.get('email')).toBe('ada@acme.com');
});
