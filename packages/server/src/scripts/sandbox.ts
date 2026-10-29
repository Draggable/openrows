import { createHash } from 'node:crypto';
import { SCRIPT_SANDBOX_PATH, sandboxDocument, sandboxFrameScript } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';

/**
 * The browser scripts' sandbox document, `GET /sandbox/script`: static, the same for
 * everyone, holding no data. The app frames it with `sandbox="allow-scripts"`, and its CSP says
 * `sandbox allow-scripts` too, so even opened on its own it runs in an opaque origin: no cookies,
 * no storage, no access to the app's DOM. Its one inline script is allowed by hash; the script
 * runs in a worker from a blob URL (`worker-src blob:`, `'unsafe-eval'` for the script's code)
 * that inherits the policy, so `connect-src 'none'` leaves it no network at all. Only the app's
 * own pages may frame it.
 */
export function sandboxContentSecurityPolicy(scriptHash: string): string {
  return [
    `default-src 'none'`,
    `script-src 'sha256-${scriptHash}' 'unsafe-eval'`,
    `worker-src blob:`,
    `connect-src 'none'`,
    `img-src 'none'`,
    `style-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors 'self'`,
    `sandbox allow-scripts`,
  ].join('; ');
}

export function sandboxRoutes(routes: RouteRegistry) {
  const script = sandboxFrameScript();
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  const html = sandboxDocument(script);
  const csp = sandboxContentSecurityPolicy(hash);
  routes.public('GET', SCRIPT_SANDBOX_PATH, (c) =>
    c.html(html, 200, {
      'Content-Security-Policy': csp,
      'X-Frame-Options': 'SAMEORIGIN',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'no-cache',
    })
  );
}
