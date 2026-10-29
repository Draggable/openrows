import {
  cacheKeyUrl,
  DATA_CACHE_PREFIX,
  dataCacheName,
  isAppNavigation,
  isCacheableApi,
  isDataCache,
  isStorableAnswer,
  MAX_DATA_ENTRIES,
  ME_PATH,
  OFFLINE_HEADER,
  SHELL_CACHE_PREFIX,
  shellCacheName,
  userIdOfMe,
} from './policy';

/** What the service worker's handlers need from its global scope (fakes in tests). */
export interface WorkerDeps {
  caches: CacheStorage;
  fetch: (request: Request) => Promise<Response>;
  /** The app's origin. */
  origin: string;
  /** The built files to precache, as absolute paths (`/index.html`, `/assets/…`). */
  precache: readonly string[];
  /** The build's id: the shell cache's suffix. */
  build: string;
  /** Tells the page that sent an API request whether the network answered (the banner). */
  notify?: (clientId: string, networkAnswered: boolean) => void;
}

/** How the worker answers a request: the response, and work to wait for after it. */
export type Handled = { response: Promise<Response>; after?: Promise<unknown> };

/**
 * The service worker's behaviour, apart from its global scope so it can be tested:
 * - the app shell is precached at install; its files are served from the cache first, and a
 *   navigation that fails offline gets the cached index.html;
 * - the API's reads go to the network first; a 200 JSON answer is kept in the signed-in user's
 *   cache, which answers only when the network fails; never another user's (see policy.ts).
 */
export function createWorker(deps: WorkerDeps) {
  const shell = shellCacheName(deps.build);
  const precached = new Set(deps.precache);

  async function install(): Promise<void> {
    const cache = await deps.caches.open(shell);
    await cache.addAll([...deps.precache]);
  }

  /** Drops the shells of earlier builds. */
  async function activate(): Promise<void> {
    const names = await deps.caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== shell)
        .map((name) => deps.caches.delete(name))
    );
  }

  /** Deletes every user's data (signing out, a 401, another user signing in). */
  async function clearData(except?: string): Promise<void> {
    const names = await deps.caches.keys();
    await Promise.all(
      names
        .filter((name) => isDataCache(name) && name !== except)
        .map((name) => deps.caches.delete(name))
    );
  }

  /** The signed-in user's data cache, if `/api/me` named one. */
  async function currentDataCache(): Promise<string | null> {
    const names = await deps.caches.keys();
    return names.find((name) => name.startsWith(DATA_CACHE_PREFIX)) ?? null;
  }

  async function store(name: string, key: string, body: ArrayBuffer, contentType: string) {
    const cache = await deps.caches.open(name);
    await cache.put(
      new Request(key),
      new Response(body, { status: 200, headers: { 'Content-Type': contentType } })
    );
    const keys = await cache.keys();
    const extra = keys.length - MAX_DATA_ENTRIES;
    if (extra > 0) await Promise.all(keys.slice(0, extra).map((k) => cache.delete(k)));
  }

  /**
   * Lets go of a clone's body without waiting: a tee's cancel settles only once the page's
   * branch is done too.
   */
  function discard(response: Response) {
    void response.body?.cancel().catch(() => undefined);
  }

  /** Keeps a network answer for offline use, or clears the data when the session is gone. */
  async function remember(path: string, key: string, response: Response): Promise<void> {
    if (response.status === 401) {
      discard(response);
      await clearData();
      return;
    }
    const contentType = response.headers.get('Content-Type');
    const length = Number(response.headers.get('Content-Length') ?? 0);
    if (!isStorableAnswer(response.status, contentType, length) || !contentType) {
      discard(response);
      return;
    }
    const body = await response.arrayBuffer();
    if (!isStorableAnswer(response.status, contentType, body.byteLength)) return;
    if (path === ME_PATH) {
      let userId: string | null = null;
      try {
        userId = userIdOfMe(JSON.parse(new TextDecoder().decode(body)));
      } catch {
        userId = null;
      }
      if (!userId) return clearData();
      const name = dataCacheName(userId);
      await clearData(name);
      await store(name, key, body, contentType);
      return;
    }
    // Nothing is kept until `/api/me` has said whose data this is.
    const name = await currentDataCache();
    if (name) await store(name, key, body, contentType);
  }

  async function cached(key: string): Promise<Response | null> {
    const name = await currentDataCache();
    if (!name) return null;
    const cache = await deps.caches.open(name);
    const hit = await cache.match(key, { ignoreVary: true });
    if (!hit) return null;
    const headers = new Headers(hit.headers);
    headers.set(OFFLINE_HEADER, '1');
    return new Response(hit.body, { status: 200, headers });
  }

  function api(request: Request, clientId: string): Handled {
    const url = new URL(request.url);
    const done = (async () => {
      const body = request.method === 'GET' ? '' : await request.clone().text();
      const key = await cacheKeyUrl(url.href, request.method, body);
      let answer: Response;
      try {
        answer = await deps.fetch(request);
      } catch (err) {
        deps.notify?.(clientId, false);
        const hit = await cached(key);
        if (hit) return { answer: hit, after: Promise.resolve() };
        throw err;
      }
      deps.notify?.(clientId, true);
      const after = remember(url.pathname, key, answer.clone()).catch(() => undefined);
      return { answer, after };
    })();
    return {
      response: done.then((r) => r.answer),
      after: done.then(
        (r) => r.after,
        () => undefined
      ),
    };
  }

  async function navigation(request: Request): Promise<Response> {
    try {
      return await deps.fetch(request);
    } catch (err) {
      const cache = await deps.caches.open(shell);
      const index = await cache.match('/index.html', { ignoreVary: true });
      if (index) return index;
      throw err;
    }
  }

  async function asset(request: Request): Promise<Response> {
    const cache = await deps.caches.open(shell);
    // The server varies on headers (Origin, Accept-Encoding) a precached copy can't match.
    return (await cache.match(request, { ignoreVary: true })) ?? deps.fetch(request);
  }

  /** How the worker answers `request`, or null: the browser fetches it as usual. */
  function handle(request: Request, clientId: string): Handled | null {
    const url = new URL(request.url);
    if (url.origin !== deps.origin) return null;
    if (request.mode === 'navigate') {
      return request.method === 'GET' && isAppNavigation(url.pathname)
        ? { response: navigation(request) }
        : null;
    }
    if (isCacheableApi(request.method, url.pathname) && !url.search.includes('__body=')) {
      return api(request, clientId);
    }
    if (request.method === 'GET' && precached.has(url.pathname)) {
      return { response: asset(request) };
    }
    return null;
  }

  return { install, activate, clearData, handle };
}
