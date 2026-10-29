import type { PlanOverrides, WorkspaceUsage } from '@openrows/shared';
import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { latestMessageTo } from '../auth/mailpit.js';

/**
 * Helpers for specs that run against the whole Compose stack (E2E_STACK=1): the app at the
 * Playwright baseURL, Keycloak on :8080 and Mailpit on :8025, as in the dev and CI stacks.
 */
export const KEYCLOAK_URL = 'http://localhost:8080';
export const DEV_USER = { email: 'dev@openrows.test', password: 'openrows-dev-password' };

export async function signInDevUser(page: Page) {
  await page.goto('/auth/login');
  await page.locator('#username').fill(DEV_USER.email);
  await page.locator('#password').fill(DEV_USER.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByTestId('current-user')).toContainText(DEV_USER.email);
}

/**
 * Signs a new user up through Keycloak's registration form, verifies the address from the mail
 * Mailpit caught and sets the password; ends signed in on the app's home page. Starts at `path`
 * (an invitation link works too: the app sends signed-out visitors to /login first).
 */
export async function signUp(
  page: Page,
  user: { email: string; firstName: string; lastName: string; password: string }
) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL(new RegExp(`^${KEYCLOAK_URL}/realms/openrows/`));
  await page.locator('#email').fill(user.email);
  await page.locator('#firstName').fill(user.firstName);
  await page.locator('#lastName').fill(user.lastName);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText(/verify your email/i).first()).toBeVisible();
  const link = (await latestMessageTo(user.email)).match(/https?:\/\/\S+action-token\S+/)?.[0];
  expect(link, 'verification link in the email').toBeTruthy();
  await page.goto(link ?? '');
  await expect(page.getByRole('heading', { name: 'Update password' })).toBeVisible();
  await page.getByRole('textbox', { name: 'New Password' }).fill(user.password);
  await page.getByRole('textbox', { name: 'Confirm password' }).fill(user.password);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByTestId('current-user')).toContainText(user.email);
}

/** The base, table and view ids of a grid URL (`/b/:baseId/:tableId/:viewId`). */
export function gridIds(url: string) {
  const [, baseId = '', tableId = '', viewId = ''] =
    new URL(url).pathname.match(/^\/b\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})/) ?? [];
  return { baseId, tableId, viewId };
}

/**
 * JSON calls to the app's API as the page's signed-in user (its cookies), with the app's Origin
 * as a browser sends it; each fails the test unless the answer is 2xx. `raw` answers as is.
 */
export function stackApi(page: Page) {
  const origin = new URL(page.url()).origin;
  const call = async <T>(method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown) => {
    const res = await page.request.fetch(path, { method, data, headers: { origin } });
    expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
    return (await res.json()) as T;
  };
  return {
    origin,
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, data: unknown) => call<T>('POST', path, data),
    patch: <T>(path: string, data: unknown) => call<T>('PATCH', path, data),
    raw: (method: 'GET' | 'PATCH', path: string, data?: unknown) =>
      page.request.fetch(path, { method, data, headers: { origin } }),
  };
}

/**
 * Gives a workspace plan overrides, as an operator would: CI's stack runs the hosted
 * edition, whose default Free plan has 1,000 records per base and no locked or personal views,
 * so specs about those features raise the limits of their own new workspace first. Calls
 * `workspace_plan_set` as openrows_app with DATABASE_URL (the dev stack's default, which is also
 * where the CI stack's Postgres is inside its namespace, like e2e/seed.spec.ts's CLI), then
 * waits until the api's entitlements show it (the function's NOTIFY drops its cache). The OSS
 * edition has every feature and no limit, so there it changes nothing.
 */
export async function setPlanOverrides(page: Page, workspaceId: string, overrides: PlanOverrides) {
  const client = new pg.Client({
    connectionString:
      process.env['DATABASE_URL'] ??
      'postgresql://openrows_app:openrows_app_dev@localhost:5432/openrows',
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT workspace_plan_set($1::uuid, NULL, $2::jsonb) AS ok',
      [workspaceId, JSON.stringify(overrides)]
    );
    expect(rows[0]?.ok, `workspace ${workspaceId} exists`).toBe(true);
  } finally {
    await client.end();
  }
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/workspaces/${workspaceId}/usage`);
      if (!res.ok()) return false;
      const usage = (await res.json()) as WorkspaceUsage;
      const features = Object.entries(overrides.features ?? {});
      const records = overrides.limits?.recordsPerBase;
      return (
        features.every(
          ([name, on]) => usage.features[name as keyof typeof usage.features] === on
        ) &&
        (records === undefined || usage.bases.every((b) => b.limit === records))
      );
    })
    .toBe(true);
}
