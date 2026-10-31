import type { MiddlewareHandler } from 'hono';
import type { Config } from '../config.js';
import type { AppEnv } from './context.js';

/** The S3 bucket's browser-facing origin (presigned uploads and downloads), if any. */
function objectStoreOrigin(config: Config): string | undefined {
  if (!config.s3) return undefined;
  return new URL(config.s3.publicUrl ?? config.s3.endpoint).origin;
}

/**
 * The Content-Security-Policy of the single-page app, derived from the config: the app,
 * the API and its assets are all on one origin, so `'self'` covers nearly everything.
 *
 * - Scripts: `'self'` only. The theme bootstrap is an external file (public/theme.js), and the
 *   Vite build emits no inline script, so neither `'unsafe-inline'` nor `'unsafe-eval'`.
 * - Styles: `'self' 'unsafe-inline'`. The toaster (sonner) injects its stylesheet as a `<style>`
 *   element at runtime and Radix/React set inline `style` attributes for positioning; inline
 *   styles can't run code, so this is the accepted trade-off (scripts stay strict).
 * - Images and fetches may also go to the S3 bucket's public origin: uploads PUT to presigned
 *   URLs and attachment thumbnails redirect to signed URLs.
 * - Forms may also go to the OIDC issuer: signing out is a form POST to /auth/logout that
 *   redirects to the provider's end-session endpoint, and form-action covers redirects. The
 *   browser never fetches from the issuer (the server is a BFF), so connect-src doesn't list it.
 */
export function contentSecurityPolicy(config: Config): string {
  const s3 = objectStoreOrigin(config);
  const issuer = config.oidc ? new URL(config.oidc.issuerUrl).origin : undefined;
  const sources = (...extra: (string | undefined)[]) =>
    ["'self'", ...extra.filter((s): s is string => Boolean(s))].join(' ');
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${sources(s3)}`,
    `font-src 'self'`,
    `connect-src ${sources(s3)}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action ${sources(issuer)}`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

/**
 * The CSP of public share pages, `/s/<token>`: the app's, without the OIDC issuer (nothing
 * on a share page signs in or out, so no form may be sent anywhere) and without uploads (no
 * fetch to the bucket; images still load from its signed URLs).
 */
export function shareContentSecurityPolicy(
  config: Config,
  frameAncestors: readonly string[] = []
): string {
  const s3 = objectStoreOrigin(config);
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${["'self'", s3].filter(Boolean).join(' ')}`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors ${frameAncestors.length > 0 ? frameAncestors.join(' ') : "'none'"}`,
  ].join('; ');
}

/** Paths of share links: the public page, its embed variant and its API. */
export const SHARE_PATHS = /^\/(s|embed|api\/shared)(\/|$)/;

/** Paths of public forms: the page and its API. */
export const FORM_PATHS = /^\/(f|api\/forms)(\/|$)/;

/** Cloudflare Turnstile's origin: its script and its challenge frame. */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

/**
 * The CSP of public forms, `/f/<token>`: the share page's, plus uploads to the bucket
 * (presigned PUTs) and, with Turnstile configured, its script and challenge frame. Nothing is
 * sent anywhere by a form element (`form-action 'none'`: the page submits through the API).
 */
export function formContentSecurityPolicy(config: Config): string {
  const s3 = objectStoreOrigin(config);
  const captcha = config.turnstile ? TURNSTILE_ORIGIN : undefined;
  const sources = (...extra: (string | undefined)[]) =>
    ["'self'", ...extra.filter((s): s is string => Boolean(s))].join(' ');
  return [
    `default-src 'self'`,
    `script-src ${sources(captcha)}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${sources(s3)}`,
    `font-src 'self'`,
    `connect-src ${sources(s3, captcha)}`,
    `frame-src ${captcha ?? "'none'"}`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

/** The embed page of a share link, the only page that may be framed. */
export const EMBED_PATH = /^\/embed\/[^/]+$/;

/**
 * What share link responses get on top: no Referer (the token is in the URL), no indexing
 * (owners may opt in later), and no caching anywhere, since a revoked link must stop at once.
 */
export const SHARE_HEADERS: Record<string, string> = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Cache-Control': 'private, no-store',
};

/** The headers every response gets (see securityHeaders). */
export function securityHeaderValues(config: Config): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(config),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
  // HSTS over plain http is ignored by browsers and would only confuse a dev setup.
  if (new URL(config.appUrl).protocol === 'https:') {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

const NO_STORE_PATHS = /^\/(api|auth)(\/|$)/;

/**
 * Pages a third-party app's OAuth popup (Make, Zapier, n8n...) renders on its way to the consent
 * screen: the consent screen itself and the sign-in page it bounces signed-out visitors to.
 * `Cross-Origin-Opener-Policy: same-origin` there severs the popup from the app's window, which
 * then sees `popup.closed === true` at once, gives up and verifies a connection that has no tokens.
 * These pages get `unsafe-none`; framing stays denied (frame-ancestors 'none', X-Frame-Options).
 */
export const OAUTH_POPUP_PATHS = /^\/(oauth\/authorize|login)\/?$/;

/**
 * Sets the security headers on every response: HTML, JSON, problem+json errors and static
 * files. Production has no reverse proxy adding them (Cloudflare Tunnel points straight at
 * the api). API and auth responses also get `Cache-Control: no-store`. A header a route set
 * itself wins (the attachment redirects keep their short private caching and `no-referrer`),
 * except on share link paths, which always get SHARE_HEADERS and their own CSP; the embed
 * page of a link may be framed by the link's embed origins (`frameAncestors`).
 */
export function securityHeaders(config: Config): MiddlewareHandler<AppEnv> {
  const values = Object.entries(securityHeaderValues(config));
  const share = Object.entries({
    ...SHARE_HEADERS,
    'Content-Security-Policy': shareContentSecurityPolicy(config),
  });
  const form = Object.entries({
    ...SHARE_HEADERS,
    'Content-Security-Policy': formContentSecurityPolicy(config),
  });
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    if (FORM_PATHS.test(c.req.path)) {
      for (const [name, value] of form) headers.set(name, value);
    }
    // The embed page of a link with embed origins may be framed by those origins only.
    // Every other response, of every path, keeps frame-ancestors 'none' and X-Frame-Options.
    const ancestors = c.get('frameAncestors') ?? [];
    const framed = ancestors.length > 0 && EMBED_PATH.test(c.req.path);
    if (SHARE_PATHS.test(c.req.path)) {
      for (const [name, value] of share) headers.set(name, value);
      if (framed) {
        headers.set('Content-Security-Policy', shareContentSecurityPolicy(config, ancestors));
      }
    }
    if (OAUTH_POPUP_PATHS.test(c.req.path))
      headers.set('Cross-Origin-Opener-Policy', 'unsafe-none');
    for (const [name, value] of values) {
      if (framed && name === 'X-Frame-Options') continue;
      if (!headers.has(name)) headers.set(name, value);
    }
    if (NO_STORE_PATHS.test(c.req.path) && !headers.has('Cache-Control')) {
      headers.set('Cache-Control', 'no-store');
    }
  };
}
