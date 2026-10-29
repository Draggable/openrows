import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { signInDevUser } from './helpers/stack.js';
import { expect, test, watchCsp } from './helpers/test.js';

// Realtime against the whole Compose stack (E2E_STACK=1): a signed-in page opens `/ws`
// with its session cookie (same origin, under the app's CSP), subscribes to a table and receives
// a cell change made over REST, in order with its seq; catch-up returns the same event.
test.skip(!process.env['E2E_STACK'], 'needs the Compose stack (E2E_STACK=1)');

type Table = { id: string; baseId: string; fields: { id: string; name: string }[] };

async function call<T>(
  request: APIRequestContext,
  origin: string,
  method: 'post' | 'patch',
  path: string,
  data: unknown
) {
  const res = await request[method](path, { data, headers: { origin } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

test('a subscribed page receives a cell change over the WebSocket', async ({ page }) => {
  await signInDevUser(page);
  const origin = new URL(page.url()).origin;
  const post = <T>(path: string, data: unknown) =>
    call<T>(page.request, origin, 'post', path, data);
  const workspace = await post<{ id: string }>('/api/workspaces', {
    name: `Realtime ${Date.now()}`,
  });
  const base = await post<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Live',
  });
  const table = await post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  const record = await post<{ id: string }>(`/api/tables/${table.id}/records`, {
    fields: { [name]: 'Before' },
  });

  // The socket lives in the page; messages are collected on window for the assertions.
  const subscribed = await page.evaluate(async (tableId) => {
    const w = window as unknown as { realtime: unknown[] };
    w.realtime = [];
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
    return new Promise<{ seq: number }>((resolve, reject) => {
      ws.onerror = () => reject(new Error('socket error'));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        w.realtime.push(msg);
        if (msg.type === 'ready')
          ws.send(JSON.stringify({ type: 'subscribe', target: { tableId } }));
        if (msg.type === 'subscribed') resolve(msg);
        if (msg.type === 'error') reject(new Error(msg.message));
      };
    });
  }, table.id);

  for (const value of ['One', 'Two']) {
    await call(page.request, origin, 'patch', `/api/tables/${table.id}/records/${record.id}`, {
      fields: { [name]: value },
      clientOpId: `e2e-${value}`,
    });
  }

  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { realtime: { type: string; event?: { clientOpId: string } }[] }
        ).realtime
          .flatMap((m) => (m.type === 'event' ? [m.event?.clientOpId] : []))
          .filter((id) => id?.startsWith('e2e-'))
      )
    )
    .toEqual(['e2e-One', 'e2e-Two']);

  const res = await page.request.get(`/api/bases/${base.id}/events?since=${subscribed.seq}`);
  expect(res.status()).toBe(200);
  const caught = (await res.json()) as { events: { clientOpId: string | null; seq: number }[] };
  expect(caught.events.map((e) => e.clientOpId)).toEqual(['e2e-One', 'e2e-Two']);
  const [first, second] = caught.events;
  expect(first && second && first.seq < second.seq).toBe(true);
});

// Live updates in the client: two browser contexts (two sessions of the dev user) on the
// same grid. An edit in one shows in the other; after the socket is cut (as a server restart
// does), the events missed meanwhile are replayed from the catch-up endpoint.

const gridCell = (page: Page, row: number, col: number) =>
  page.getByRole('grid').locator(`[data-cell="${row}:${col}"]`);
const liveStatus = (page: Page) => page.getByTestId('connection-status');

/** A fresh workspace with one table and record "Before", made over page's session. */
async function liveTable(page: Page) {
  const origin = new URL(page.url()).origin;
  const post = <T>(path: string, data: unknown) =>
    call<T>(page.request, origin, 'post', path, data);
  const workspace = await post<{ id: string }>('/api/workspaces', { name: `Live ${Date.now()}` });
  const base = await post<{ id: string }>(`/api/workspaces/${workspace.id}/bases`, {
    name: 'Live',
  });
  const table = await post<Table>(`/api/bases/${base.id}/tables`, { name: 'Tasks' });
  const name = table.fields.find((f) => f.name === 'Name')?.id ?? '';
  const record = await post<{ id: string }>(`/api/tables/${table.id}/records`, {
    fields: { [name]: 'Before' },
  });
  return {
    request: page.request,
    origin,
    base,
    table,
    name,
    record,
    url: `/b/${base.id}/${table.id}`,
  };
}

/** Sets the record's Name over the first page's session. */
async function patchName(live: Awaited<ReturnType<typeof liveTable>>, value: string) {
  await call(
    live.request,
    live.origin,
    'patch',
    `/api/tables/${live.table.id}/records/${live.record.id}`,
    { fields: { [live.name]: value } }
  );
}

/** A second signed-in context of the dev user, with the CSP check of the first. */
async function secondPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const seen = await watchCsp(context, new URL(baseURL ?? 'http://localhost').origin);
  const page = await context.newPage();
  return { context, page, seen };
}

test('an edit in one browser appears in the other', async ({ page, browser, baseURL }) => {
  await signInDevUser(page);
  const live = await liveTable(page);
  const other = await secondPage(browser, baseURL);
  try {
    await signInDevUser(other.page);
    for (const p of [page, other.page]) {
      await p.goto(live.url);
      await expect(gridCell(p, 0, 0)).toHaveText('Before');
      await expect(liveStatus(p)).toHaveAttribute('data-status', 'live');
    }
    const axe = await new AxeBuilder({ page })
      .include('header')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      axe.violations
        .filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))
        .map((v) => v.id)
    ).toEqual([]);

    // When the other page shows the value (its own clock: same machine as the runner).
    await other.page.evaluate(() => {
      const w = window as unknown as { seenAt?: number };
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-cell="0:0"]')?.textContent === 'After') {
          w.seenAt = Date.now();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    let sentAt = 0;
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && r.url().includes(`/api/tables/${live.table.id}/records`))
        sentAt ||= Date.now();
    });
    await gridCell(page, 0, 0).click();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('After');
    await page.keyboard.press('Enter');
    await expect(gridCell(page, 0, 0)).toHaveText('After');

    await expect(gridCell(other.page, 0, 0)).toHaveText('After', { timeout: 5000 });
    const seenAt = await other.page.evaluate(() => (window as { seenAt?: number }).seenAt ?? 0);
    const latency = seenAt - sentAt;
    console.log(`realtime latency (write sent → shown in the other browser): ${latency} ms`);
    test.info().annotations.push({ type: 'realtime latency', description: `${latency} ms` });
    expect(sentAt).toBeGreaterThan(0);
    // Target 300 ms; CI machines are shared, so the bound is generous.
    expect(latency).toBeLessThan(2000);
    // The editing page applied its own echo without a flicker back.
    await expect(gridCell(page, 0, 0)).toHaveText('After');
    expect(other.seen).toEqual([]);
  } finally {
    await other.context.close();
  }
});

test('after the socket is cut, the missed edits are replayed', async ({
  page,
  browser,
  baseURL,
}) => {
  await signInDevUser(page);
  const live = await liveTable(page);
  const other = await secondPage(browser, baseURL);
  try {
    // The other page's socket goes through a proxy the test can cut, like a server restart.
    let refuse = false;
    const sockets: { close: (o?: { code?: number; reason?: string }) => Promise<void> }[] = [];
    await other.page.routeWebSocket('/ws', (ws) => {
      if (refuse) return void ws.close({ code: 1012, reason: 'restarting' });
      ws.connectToServer();
      sockets.push(ws);
    });
    await signInDevUser(other.page);
    await other.page.goto(live.url);
    await expect(gridCell(other.page, 0, 0)).toHaveText('Before');
    await expect(liveStatus(other.page)).toHaveAttribute('data-status', 'live');
    // `live` comes with the socket's `ready`, before the subscriptions are confirmed: an edit
    // that arrives proves the page knows the base's seq to resume from.
    await patchName(live, 'Warm up');
    await expect(gridCell(other.page, 0, 0)).toHaveText('Warm up');

    refuse = true;
    // The page sees the server close its socket (1012: service restart).
    for (const ws of sockets) await ws.close({ code: 1012, reason: 'restarting' });
    await expect(liveStatus(other.page)).toHaveAttribute('data-status', 'reconnecting');

    // Two edits while the other page is cut off.
    for (const value of ['Missed one', 'Missed two']) await patchName(live, value);
    await expect(gridCell(other.page, 0, 0)).toHaveText('Warm up');
    // A long outage shows the banner.
    await expect(other.page.getByTestId('offline-banner')).toContainText('Connection lost');

    const caughtUp = other.page.waitForResponse(
      (r) => r.url().includes(`/api/bases/${live.base.id}/events?since=`) && r.ok()
    );
    refuse = false;
    await expect(liveStatus(other.page)).toHaveAttribute('data-status', 'live', {
      timeout: 15_000,
    });
    const replay = (await (await caughtUp).json()) as { events: { kind: string }[] };
    expect(replay.events.filter((e) => e.kind === 'record.updated')).toHaveLength(2);
    await expect(gridCell(other.page, 0, 0)).toHaveText('Missed two');
    await expect(other.page.getByTestId('offline-banner')).toBeHidden();
    expect(other.seen).toEqual([]);
  } finally {
    await other.context.close();
  }
});

test('a socket cut before its subscriptions are confirmed resyncs the grid', async ({
  page,
  browser,
  baseURL,
}) => {
  await signInDevUser(page);
  const live = await liveTable(page);
  const other = await secondPage(browser, baseURL);
  try {
    // The first socket never forwards `subscribed`: the page is live but has no seq yet, the
    // window in which CI once cut it.
    let first = true;
    let cut: (() => Promise<void>) | undefined;
    let hold = () => {};
    const held = new Promise<void>((resolve) => {
      hold = resolve;
    });
    await other.page.routeWebSocket('/ws', (ws) => {
      const server = ws.connectToServer();
      if (!first) return;
      first = false;
      server.onMessage((message) => {
        if (String(message).includes('"type":"subscribed"')) return hold();
        ws.send(message);
      });
      cut = () => ws.close({ code: 1012, reason: 'restarting' });
    });
    await signInDevUser(other.page);
    await other.page.goto(live.url);
    await expect(gridCell(other.page, 0, 0)).toHaveText('Before');
    await held;
    await expect(liveStatus(other.page)).toHaveAttribute('data-status', 'live');

    await patchName(live, 'Missed');
    await cut?.();
    // The next socket comes up without a seq to catch up from: the grid refetches instead.
    await expect(gridCell(other.page, 0, 0)).toHaveText('Missed', { timeout: 15_000 });
    await expect(liveStatus(other.page)).toHaveAttribute('data-status', 'live');
    // And it is live again from there.
    await patchName(live, 'After');
    await expect(gridCell(other.page, 0, 0)).toHaveText('After');
    expect(other.seen).toEqual([]);
  } finally {
    await other.context.close();
  }
});
