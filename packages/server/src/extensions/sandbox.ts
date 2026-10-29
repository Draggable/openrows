import { createHash } from 'node:crypto';
import {
  EXTENSION_EMBED_ORIGINS,
  EXTENSION_SANDBOX_PATH,
  extensionFrameScript,
  extensionSandboxDocument,
} from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';

/**
 * The extensions' sandbox document, `GET /sandbox/extension`: static, the same for
 * everyone, holding no data. The app frames it with `sandbox="allow-scripts allow-modals"`, and
 * its CSP says the same, so even opened on its own it runs in an opaque origin: no cookies, no
 * storage, no access to the app's DOM. Its one inline script (the bootstrap) is allowed by hash;
 * the bundle's JS runs through `Function` (`'unsafe-eval'`), its CSS as an inline style.
 * `connect-src 'none'`, no frames and only `data:`/`blob:` images leave it no network to fetch
 * from. `?embed=1` (the host adds it only for a manifest with `embed:frames`) also allows
 * `https:` images and frames of EXTENSION_EMBED_ORIGINS. Only the app's own pages may frame it.
 */
export function extensionContentSecurityPolicy(scriptHash: string, embed: boolean): string {
  return [
    `default-src 'none'`,
    `script-src 'sha256-${scriptHash}' 'unsafe-eval'`,
    `style-src 'unsafe-inline'`,
    `img-src data: blob:${embed ? ' https:' : ''}`,
    `font-src data:`,
    `media-src data: blob:`,
    `frame-src ${embed ? EXTENSION_EMBED_ORIGINS.join(' ') : "'none'"}`,
    `connect-src 'none'`,
    `worker-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors 'self'`,
    `sandbox allow-scripts allow-modals`,
  ].join('; ');
}

export function extensionSandboxRoutes(routes: RouteRegistry) {
  const script = extensionFrameScript();
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  const html = extensionSandboxDocument(script);
  const csp = {
    plain: extensionContentSecurityPolicy(hash, false),
    embed: extensionContentSecurityPolicy(hash, true),
  };
  routes.public('GET', EXTENSION_SANDBOX_PATH, (c) =>
    c.html(html, 200, {
      'Content-Security-Policy': c.req.query('embed') === '1' ? csp.embed : csp.plain,
      'X-Frame-Options': 'SAMEORIGIN',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-cache',
    })
  );
}
