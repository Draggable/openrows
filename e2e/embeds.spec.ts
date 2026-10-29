import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, ConsoleMessage, Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Embeds against the whole Compose stack (E2E_STACK=1): the dev user makes a view link
// that one site may embed and copies its embed code from the share dialog. A partner page on that
// origin shows the view in an iframe; the same code on another origin is refused by the browser
// (frame-ancestors), and so is the full /s/ page and the app itself on the allowed origin. The
// partner pages are served by Playwright (`page.route`): no other server is needed.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

const ALLOWED = 'https://partner.example';
const BLOCKED = 'https://elsewhere.example';

/** Serves `body` as the page of `origin` in `context`. */
async function servePartner(context: BrowserContext, origin: string, body: string) {
  await context.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Partner</title></head><body><h1>Partner page</h1>${body}</body></html>`,
    })
  );
}

/** Resolves when the browser logs that it refused to frame something under frame-ancestors. */
function frameRefusal(page: Page): Promise<ConsoleMessage> {
  return page.waitForEvent('console', {
    predicate: (m) => m.type() === 'error' && /frame-ancestors/.test(m.text()),
    timeout: 15_000,
  });
}

test('an embeddable link frames on its site only', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const call = async <T>(method: 'post' | 'get', path: string, data?: unknown) => {
    const res = await page.request[method](path, { data, headers: { origin } });
    expect(res.ok(), `${method} ${path}`).toBe(true);
    return (await res.json()) as T;
  };
  const ws = await call<{ id: string }>('post', '/api/workspaces', { name: `Embeds ${stamp}` });
  const base = await call<{ id: string }>('post', `/api/workspaces/${ws.id}/bases`, {
    name: 'Partners',
  });
  const table = await call<{ id: string; fields: { id: string; name: string }[] }>(
    'post',
    `/api/bases/${base.id}/tables`,
    { name: 'Tasks' }
  );
  const name = table.fields.find((f) => f.name === 'Name');
  if (!name) throw new Error('no Name field');
  await call('post', `/api/tables/${table.id}/records`, {
    records: [{ fields: { [name.id]: 'Embedded launch' } }],
  });
  const { views } = await call<{ views: { id: string }[] }>('get', `/api/tables/${table.id}/views`);
  const viewId = views[0]?.id ?? '';

  let snippet = '';
  let link = '';
  await test.step('make an embeddable link and copy its embed code', async () => {
    await page.goto(`/b/${base.id}/${table.id}/${viewId}`);
    await expect(page.getByRole('columnheader', { name: 'Name' })).toBeVisible();
    await page.getByRole('button', { name: 'Grid view options' }).click();
    await page.getByRole('menuitem', { name: 'Share view' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share Grid view' });
    await expect(dialog.getByText('No links yet.')).toBeVisible();
    await dialog.getByLabel(/Sites that may embed it/).fill(`${ALLOWED}/`);
    await dialog.getByRole('button', { name: 'Create link' }).click();
    link = await dialog.getByLabel(/New link/).inputValue();
    await dialog.getByLabel('Theme').selectOption('dark');
    const code = dialog.getByLabel('Embed code');
    await expect(code).toHaveValue(/\/embed\/[A-Za-z0-9_-]{43}\?theme=dark"/);
    snippet = await code.inputValue();
    expect(snippet).toContain(`src="${origin}/embed/`);
    await expect(dialog.getByRole('list', { name: 'Share links' })).toContainText(
      'Embeddable on 1 site'
    );
  });
  const token = new URL(link).pathname.split('/')[2] ?? '';

  // The partner pages are public https origins and the stack is on localhost: Chrome's Local
  // Network Access checks would block the frame before its CSP is read, so the visitor allows it
  // (a real deployment is a public origin too).
  const visitor = await browser.newContext({ permissions: ['local-network-access'] });
  const violations = await watchCsp(visitor, origin);
  try {
    await test.step('the embed page answers its frame-ancestors', async () => {
      const res = await visitor.request.get(`${origin}/embed/${token}?theme=dark`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-security-policy']).toContain(`frame-ancestors ${ALLOWED}`);
      expect(res.headers()['x-frame-options']).toBeUndefined();
      const full = await visitor.request.get(`${origin}/s/${token}`);
      expect(full.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(full.headers()['x-frame-options']).toBe('DENY');
    });

    await servePartner(visitor, ALLOWED, snippet);
    await servePartner(visitor, BLOCKED, snippet);

    await test.step('a page on the allowed site shows the view in the iframe', async () => {
      const partner = await visitor.newPage();
      await partner.goto(`${ALLOWED}/`);
      const frame = partner.frameLocator('iframe');
      const grid = frame.getByRole('table', { name: 'Grid view' });
      await expect(grid.getByText('Embedded launch')).toBeVisible();
      await expect(frame.locator('html')).toHaveClass(/\bdark\b/);
      await expect(frame.getByRole('link', { name: /View in OpenRows/ })).toHaveAttribute(
        'target',
        '_blank'
      );
      await partner.close();
    });

    await test.step('the same code on another site is refused by the browser', async () => {
      const elsewhere = await visitor.newPage();
      const refused = frameRefusal(elsewhere);
      await elsewhere.goto(`${BLOCKED}/`);
      expect((await refused).text()).toContain(origin);
      await expect(
        elsewhere.frameLocator('iframe').getByRole('table', { name: 'Grid view' })
      ).toHaveCount(0);
      await expect(elsewhere.frameLocator('iframe').getByText('Embedded launch')).toHaveCount(0);
      await elsewhere.close();
    });

    await test.step('the allowed site still cannot frame the full page or the app', async () => {
      for (const path of [`/s/${token}`, `/b/${base.id}`, '/']) {
        await visitor.unroute(`${ALLOWED}/**`);
        await servePartner(
          visitor,
          ALLOWED,
          `<iframe src="${origin}${path}" title="Not embeddable"></iframe>`
        );
        const partner = await visitor.newPage();
        const refused = frameRefusal(partner);
        await partner.goto(`${ALLOWED}/`);
        await refused;
        await expect(partner.frameLocator('iframe').getByText('Embedded launch')).toHaveCount(0);
        await partner.close();
      }
    });

    await test.step('the embed page itself is accessible', async () => {
      const guest = await visitor.newPage();
      await guest.goto(`${origin}/embed/${token}?theme=light`);
      await expect(
        guest.getByRole('table', { name: 'Grid view' }).getByText('Embedded launch')
      ).toBeVisible();
      await expect(guest.locator('html')).not.toHaveClass(/\bdark\b/);
      const results = await new AxeBuilder({ page: guest })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const serious = results.violations.filter((v) =>
        ['serious', 'critical'].includes(v.impact ?? '')
      );
      expect(serious.map((v) => v.id)).toEqual([]);
    });
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  } finally {
    await visitor.close();
  }
});
