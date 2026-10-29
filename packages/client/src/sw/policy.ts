/**
 * What the service worker keeps and for whom, as pure functions over paths and names.
 *
 * Two kinds of cache:
 * - the app shell, `openrows-shell-<build>`: the built files, precached at install, shared by
 *   everyone (nothing in it is personal) and replaced by the next build;
 * - one user's data, `openrows-data-<userId>`: the API's JSON answers that user last read
 *   (pages of each view they opened, the base, its tables and fields), served only when the
 *   network fails. There is at most one: it is named after the user `/api/me` last answered for,
 *   any other is deleted, and a 401 or signing out deletes it.
 */

export const SHELL_CACHE_PREFIX = 'openrows-shell-';
export const DATA_CACHE_PREFIX = 'openrows-data-';

/** Answers kept per user (the oldest written go first). */
export const MAX_DATA_ENTRIES = 400;
/** A bigger answer isn't kept (a view page is far smaller). */
export const MAX_DATA_BYTES = 2_000_000;

/** The header on an answer served from the cache while offline. */
export const OFFLINE_HEADER = 'X-OpenRows-Offline';

/** The message the worker sends a page after an API request: did the network answer? */
export const NETWORK_MESSAGE = 'openrows:network';

export const ME_PATH = '/api/me';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function dataCacheName(userId: string): string {
  return `${DATA_CACHE_PREFIX}${userId}`;
}

export function isDataCache(name: string): boolean {
  return name.startsWith(DATA_CACHE_PREFIX);
}

export function shellCacheName(build: string): string {
  return `${SHELL_CACHE_PREFIX}${build}`;
}

/**
 * Paths the server owns or that aren't the signed-in app: share links, embeds and public forms
 * have their own headers and CSP, the sandbox frame is the scripts'.
 */
const NOT_APP = /^\/(api|auth|s|embed|f|hooks|sandbox|email|mcp|health|ready)(\/|$)|^\/llms\.txt$/;

/** Whether a navigation to `pathname` may fall back to the cached app shell when offline. */
export function isAppNavigation(pathname: string): boolean {
  return !NOT_APP.test(pathname);
}

/** The POSTs that only read (a view's records, an interface page's numbers and charts). */
const READ_POSTS = [
  /^\/api\/tables\/[^/]+\/records\/query$/,
  /^\/api\/interfaces\/[^/]+\/pages\/[^/]+\/data$/,
];

/**
 * Never kept: public share links and forms (not the user's), the ops console, billing, tokens,
 * the realtime catch-up (stale events would be replayed), and files (exports, templates).
 */
const NEVER =
  /^\/api\/(shared|forms|admin|billing|me\/tokens|me\/impersonation|me\/support-access)(\/|$)|\/events$|\.[a-z0-9]+$/i;

/** Whether the worker keeps (and offline serves) the answer to `method pathname`. */
export function isCacheableApi(method: string, pathname: string): boolean {
  if (!pathname.startsWith('/api/')) return false;
  if (NEVER.test(pathname)) return false;
  if (method === 'GET') return true;
  return method === 'POST' && READ_POSTS.some((re) => re.test(pathname));
}

/** Whether an answer may be kept: a 200 JSON answer, not too big. */
export function isStorableAnswer(status: number, contentType: string | null, bytes: number) {
  return (
    status === 200 &&
    !!contentType &&
    /^application\/(problem\+)?json\b/i.test(contentType) &&
    bytes <= MAX_DATA_BYTES
  );
}

/** The user `/api/me` answered for (only a UUID is trusted as a cache name). */
export function userIdOfMe(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const user = (body as { user?: unknown }).user;
  if (typeof user !== 'object' || user === null) return null;
  const id = (user as { id?: unknown }).id;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The cache key of a request: its URL for a GET; for a read POST, the URL with the body's
 * SHA-256 (one view's pages differ only by their bodies). The Cache API keys GETs only.
 */
export async function cacheKeyUrl(url: string, method: string, body: string): Promise<string> {
  if (method === 'GET') return url;
  const key = new URL(url);
  key.searchParams.set('__body', await sha256(body));
  return key.href;
}
