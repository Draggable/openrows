import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { RouteRegistry } from './authz/routes.js';
import { notFound } from './lib/errors.js';

/** Paths the server owns. Anything else is the client's (its router decides what's a 404). */
const SERVER_PATHS = /^\/(api|auth)(\/|$)|^\/(health|ready|mcp)$/;

/** The client's index.html from `dir`, revalidated on every load (for a route's own handler). */
export function clientIndex(dir: string) {
  return serveStatic({
    root: resolve(dir),
    path: 'index.html',
    onFound: (_path, c) => {
      c.header('Cache-Control', 'no-cache');
    },
  });
}

/**
 * Serves the built client from `dir` on the API's origin (the Docker image): files as they
 * are, and index.html for any other GET, so client-side routes survive a reload. Vite's hashed
 * files under /assets are cached for a year; everything else must be revalidated, so a deploy
 * is picked up on the next load. Unknown server paths and missing files (a path with an
 * extension) stay problem+json 404s. Register this after every other route.
 */
export function clientRoutes(routes: RouteRegistry, dir: string): void {
  const root = resolve(dir);
  const files = serveStatic({
    root,
    onFound: (path, c) => {
      c.header(
        'Cache-Control',
        path.startsWith(resolve(root, 'assets'))
          ? 'public, max-age=31536000, immutable'
          : 'no-cache'
      );
    },
  });
  const index = clientIndex(root);

  const none = async () => {};
  routes.public('GET', '/*', async (c) => {
    const path = c.req.path;
    if (SERVER_PATHS.test(path)) return notFound(c);
    const file = await files(c, none);
    if (file) return file;
    if (/\.[^/]+$/.test(path)) return notFound(c);
    return (await index(c, none)) ?? notFound(c);
  });
}
