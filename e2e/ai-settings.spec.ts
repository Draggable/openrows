import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { IDS, mockApi } from './fixtures/mockApi.js';
import { expect, test } from './helpers/test.js';

// Settings → AI against the mocked API: an owner opens it from the workspace menu, brings
// their own key for an OpenAI-compatible provider, tests the connection and removes the key.
// The key goes to the server once and never comes back into the page. Needs only the built
// client.

const KEY = 'sk-e2e-PLAYWRIGHTKEY-0123456789';
const PAGE = `/w/${IDS.workspace}/ai`;

interface State {
  workspace: { baseUrl: string; model: string } | null;
  /** The hosted provider's credits this month; absent: no instance provider. */
  hosted?: { used: number; limit: number };
}

function settings(state: State) {
  return {
    workspaceId: IDS.workspace,
    source: state.workspace ? 'workspace' : state.hosted ? 'instance' : null,
    instance: state.hosted
      ? {
          available: true,
          model: 'hosted-model',
          credits: { ...state.hosted, resetsOn: '2026-11-01' },
        }
      : { available: false, model: null },
    workspace: state.workspace
      ? { ...state.workspace, hasKey: true, updatedAt: '2026-10-28T10:00:00.000Z' }
      : null,
    allowedHosts: null,
  };
}

async function owner(page: Page, state: State, saves: unknown[]) {
  await mockApi(page, { rows: 1 });
  const fulfill = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route(`**/api/workspaces/${IDS.workspace}`, (route) =>
    route.fulfill(
      fulfill({
        id: IDS.workspace,
        name: 'Ada',
        role: 'owner',
        createdAt: '2026-10-25T10:00:00.000Z',
        updatedAt: '2026-10-25T10:00:00.000Z',
      })
    )
  );
  await page.route(`**/api/workspaces/${IDS.workspace}/ai`, (route) =>
    route.fulfill(
      fulfill({
        workspaceId: IDS.workspace,
        available: !!state.workspace || !!state.hosted,
        source: state.workspace ? 'workspace' : state.hosted ? 'instance' : null,
      })
    )
  );
  await page.route(`**/api/workspaces/${IDS.workspace}/ai/settings`, (route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as { baseUrl: string; model: string };
      saves.push(body);
      state.workspace = { baseUrl: body.baseUrl, model: body.model };
    }
    if (method === 'DELETE') state.workspace = null;
    return route.fulfill(fulfill(settings(state)));
  });
  await page.route(`**/api/workspaces/${IDS.workspace}/ai/settings/test`, (route) =>
    route.fulfill(
      fulfill({
        ok: true,
        source: 'workspace',
        model: 'gpt-4.1-mini-2026',
        error: null,
        usage: { inputTokens: 40, outputTokens: 6, totalTokens: 46 },
        latencyMs: 312,
      })
    )
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

test('an owner brings their own key, tests it and removes it', async ({ page }) => {
  const saves: unknown[] = [];
  await owner(page, { workspace: null }, saves);
  await page.goto(`/w/${IDS.workspace}`);
  await page.getByRole('button', { name: /^Workspace: / }).click();
  await page.getByRole('menuitem', { name: 'AI' }).click();
  await expect(page).toHaveURL(PAGE);
  await expect(page.getByRole('heading', { name: 'Ada · AI' })).toBeVisible();
  await expect(page.getByTestId('ai-source')).toContainText('AI is off');
  await expectAxeClean(page);

  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue(
    'https://api.anthropic.com/v1'
  );
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('claude-haiku-5-5');
  await page.getByLabel('API key', { exact: true }).fill(KEY);
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByTestId('ai-source')).toHaveText(
    "AI features use this workspace's own key."
  );
  expect(saves).toEqual([
    { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', apiKey: KEY },
  ]);
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute(
    'placeholder',
    /A key is saved/
  );
  expect(await page.content()).not.toContain(KEY);

  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toHaveText(
    'Connected: gpt-4.1-mini-2026 answered in 312 ms (46 tokens).'
  );
  await expectAxeClean(page);

  // After a reload the page still only knows that a key is stored.
  await page.reload();
  await expect(page.getByLabel('Provider', { exact: true })).toHaveValue('anthropic');
  expect(await page.content()).not.toContain(KEY);

  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByTestId('ai-source')).toContainText('AI is off');
  await expect(page.getByRole('button', { name: 'Remove key' })).toHaveCount(0);
});

test("hosted AI (#151): the month's credits, and an own key that doesn't use them", async ({
  page,
}) => {
  const saves: unknown[] = [];
  await owner(page, { workspace: null, hosted: { used: 100, limit: 100 } }, saves);
  await page.goto(PAGE);
  const source = page.getByTestId('ai-source');
  await expect(source).toContainText("AI features use OpenRows' AI provider (hosted-model).");
  await expect(source).toContainText("This month's 100 AI credits are used up until November 1.");
  await expect(source).toContainText("its requests don't use credits");
  await expectAxeClean(page);

  // Bring your own key: AI keeps working past the credits.
  await page.getByLabel('API key', { exact: true }).fill(KEY);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(source).toHaveText("AI features use this workspace's own key.");
  expect(saves).toHaveLength(1);
});
