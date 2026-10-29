import { describe, expect, it } from 'vitest';
import { createWorker } from './handlers';
import { isAppNavigation, isCacheableApi, MAX_DATA_ENTRIES, OFFLINE_HEADER } from './policy';

const ORIGIN = 'https://app.openrows.test';
const ADA = '0190a000-0000-7000-8000-000000000001';
const BOB = '0190a000-0000-7000-8000-000000000002';

/** Cache Storage in memory: entries by URL in insertion order (a put moves an entry last). */
class MemoryCache {
  entries = new Map<string, Response>();
  async put(request: Request | string, response: Response) {
    const url = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    const body = await response.arrayBuffer();
    this.entries.delete(url);
    this.entries.set(
      url,
      new Response(body, { status: response.status, headers: response.headers })
    );
  }
  async addAll(urls: string[]) {
    for (const url of urls) {
      await this.put(
        url,
        new Response(`file ${url}`, { headers: { 'Content-Type': 'text/plain' } })
      );
    }
  }
  async match(request: Request | string) {
    const url = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    return this.entries.get(url)?.clone();
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  async delete(request: Request | string) {
    const url = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    return this.entries.delete(url);
  }
}

class MemoryCacheStorage {
  caches = new Map<string, MemoryCache>();
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
  async has(name: string) {
    return this.caches.has(name);
  }
  async match() {
    return undefined;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A worker on a fake network: `answers` by `METHOD path`, or a network error when `offline`. */
function setup() {
  const storage = new MemoryCacheStorage();
  const net = {
    offline: false,
    answers: new Map<string, () => Response>(),
    notified: [] as boolean[],
  };
  const worker = createWorker({
    caches: storage as unknown as CacheStorage,
    origin: ORIGIN,
    build: 'b1',
    precache: ['/index.html', '/assets/index-abc.js'],
    fetch: async (request) => {
      if (net.offline) throw new TypeError('Failed to fetch');
      const url = new URL(request.url);
      const answer = net.answers.get(`${request.method} ${url.pathname}${url.search}`);
      return answer ? answer() : json({ title: 'Not found' }, 404);
    },
    notify: (_client, ok) => net.notified.push(ok),
  });
  async function send(path: string, init: RequestInit & { mode?: RequestMode } = {}) {
    const { mode, ...rest } = init;
    const request = new Request(`${ORIGIN}${path}`, rest);
    if (mode === 'navigate') Object.defineProperty(request, 'mode', { value: 'navigate' });
    const handled = worker.handle(request, 'client-1');
    if (!handled) return null;
    const response = await handled.response;
    await handled.after;
    return response;
  }
  const signIn = (userId: string) =>
    net.answers.set('GET /api/me', () => json({ user: { id: userId } }));
  const dataCaches = () => [...storage.caches.keys()].filter((n) => n.startsWith('openrows-data-'));
  return { storage, net, worker, send, signIn, dataCaches };
}

describe('the service worker policy', () => {
  it('keeps API reads and the read POSTs, never public, console or file routes', () => {
    expect(isCacheableApi('GET', '/api/me')).toBe(true);
    expect(isCacheableApi('GET', '/api/bases/x/tables')).toBe(true);
    expect(isCacheableApi('POST', '/api/tables/x/records/query')).toBe(true);
    expect(isCacheableApi('POST', '/api/interfaces/i/pages/p/data')).toBe(true);
    expect(isCacheableApi('POST', '/api/tables/x/records')).toBe(false);
    expect(isCacheableApi('PATCH', '/api/tables/x/records/r')).toBe(false);
    expect(isCacheableApi('GET', '/api/shared/token/view')).toBe(false);
    expect(isCacheableApi('GET', '/api/forms/token')).toBe(false);
    expect(isCacheableApi('GET', '/api/admin/workspaces')).toBe(false);
    expect(isCacheableApi('GET', '/api/me/tokens')).toBe(false);
    expect(isCacheableApi('GET', '/api/bases/x/events')).toBe(false);
    expect(isCacheableApi('GET', '/api/bases/x/export.zip')).toBe(false);
    expect(isCacheableApi('GET', '/auth/providers')).toBe(false);
  });

  it('falls back to the app shell for app pages only', () => {
    for (const path of ['/', '/b/x/y/z', '/w/x/members', '/settings', '/i/x', '/login']) {
      expect(isAppNavigation(path), path).toBe(true);
    }
    for (const path of ['/s/token', '/embed/token', '/f/token', '/auth/login', '/api/me']) {
      expect(isAppNavigation(path), path).toBe(false);
    }
  });
});

describe('the service worker', () => {
  it('precaches the shell and drops older builds', async () => {
    const t = setup();
    await t.storage.open('openrows-shell-b0');
    await t.worker.install();
    await t.worker.activate();
    expect([...t.storage.caches.keys()]).toEqual(['openrows-shell-b1']);
    t.net.offline = true;
    const asset = await t.send('/assets/index-abc.js');
    expect(await asset?.text()).toBe('file /assets/index-abc.js');
  });

  it('answers app navigations from the shell when offline, never share pages', async () => {
    const t = setup();
    await t.worker.install();
    t.net.offline = true;
    const page = await t.send('/b/base/table/view', { mode: 'navigate' });
    expect(await page?.text()).toBe('file /index.html');
    expect(await t.send('/s/token', { mode: 'navigate' })).toBeNull();
  });

  it("serves the user's last answers offline, marked, and nothing before /api/me", async () => {
    const t = setup();
    t.net.answers.set('GET /api/bases/b1', () => json({ id: 'b1', name: 'Roadmap' }));
    // No user yet: nothing is kept.
    await t.send('/api/bases/b1');
    expect(t.dataCaches()).toEqual([]);

    t.signIn(ADA);
    await t.send('/api/me');
    await t.send('/api/bases/b1');
    expect(t.dataCaches()).toEqual([`openrows-data-${ADA}`]);
    expect(t.net.notified).toEqual([true, true, true]);

    t.net.offline = true;
    const offline = await t.send('/api/bases/b1');
    expect(offline?.headers.get(OFFLINE_HEADER)).toBe('1');
    expect(await offline?.json()).toEqual({ id: 'b1', name: 'Roadmap' });
    expect(t.net.notified.at(-1)).toBe(false);
    // Something never read fails like the network did.
    await expect(t.send('/api/bases/other')).rejects.toThrow('Failed to fetch');
  });

  it('keys read POSTs by their body: each page of a view apart', async () => {
    const t = setup();
    t.signIn(ADA);
    await t.send('/api/me');
    let page = 0;
    t.net.answers.set('POST /api/tables/t1/records/query', () => json({ page: page++ }));
    const query = (offset: number) =>
      t.send('/api/tables/t1/records/query', {
        method: 'POST',
        body: JSON.stringify({ viewId: 'v1', offset }),
        headers: { 'Content-Type': 'application/json' },
      });
    await query(0);
    await query(100);
    t.net.offline = true;
    expect(await (await query(100))?.json()).toEqual({ page: 1 });
    expect(await (await query(0))?.json()).toEqual({ page: 0 });
  });

  it('never keeps writes, errors or other content types', async () => {
    const t = setup();
    t.signIn(ADA);
    await t.send('/api/me');
    t.net.answers.set('PATCH /api/tables/t1/records/r1', () => json({ ok: true }));
    t.net.answers.set('GET /api/bases/gone', () => json({ title: 'Not found' }, 404));
    t.net.answers.set('GET /api/bases/text', () => new Response('plain'));
    expect(await t.send('/api/tables/t1/records/r1', { method: 'PATCH', body: '{}' })).toBeNull();
    await t.send('/api/bases/gone');
    await t.send('/api/bases/text');
    const cache = t.storage.caches.get(`openrows-data-${ADA}`);
    expect([...(cache?.entries.keys() ?? [])]).toEqual([`${ORIGIN}/api/me`]);
  });

  it('deletes the data when the session is gone or another user signs in', async () => {
    const t = setup();
    t.net.answers.set('GET /api/bases/b1', () => json({ id: 'b1' }));
    t.signIn(ADA);
    await t.send('/api/me');
    await t.send('/api/bases/b1');

    // Bob signs in on this browser: Ada's data goes before anything of his is kept.
    t.signIn(BOB);
    await t.send('/api/me');
    expect(t.dataCaches()).toEqual([`openrows-data-${BOB}`]);
    const bob = t.storage.caches.get(`openrows-data-${BOB}`);
    expect([...(bob?.entries.keys() ?? [])]).toEqual([`${ORIGIN}/api/me`]);

    // Any 401 (signed out elsewhere, the session expired) deletes it.
    t.net.answers.set('GET /api/bases/b1', () => json({ title: 'Unauthorized' }, 401));
    await t.send('/api/bases/b1');
    expect(t.dataCaches()).toEqual([]);
    t.net.offline = true;
    await expect(t.send('/api/me')).rejects.toThrow('Failed to fetch');
  });

  it('keeps at most the newest answers', async () => {
    const t = setup();
    t.signIn(ADA);
    await t.send('/api/me');
    for (let i = 0; i < MAX_DATA_ENTRIES + 5; i++) {
      t.net.answers.set(`GET /api/tables/t${i}`, () => json({ i }));
      await t.send(`/api/tables/t${i}`);
    }
    const cache = t.storage.caches.get(`openrows-data-${ADA}`);
    const keys = [...(cache?.entries.keys() ?? [])];
    expect(keys).toHaveLength(MAX_DATA_ENTRIES);
    expect(keys.at(-1)).toBe(`${ORIGIN}/api/tables/t${MAX_DATA_ENTRIES + 4}`);
  });

  it('leaves other origins alone', async () => {
    const t = setup();
    const handled = t.worker.handle(new Request('https://s3.example.test/file.png'), 'c');
    expect(handled).toBeNull();
  });
});
