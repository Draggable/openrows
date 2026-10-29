import { type BrowserContext, test as base, expect } from '@playwright/test';

export { expect };

declare global {
  interface Window {
    __openrowsCspViolation?: (violation: string) => void;
  }
}

/**
 * Collects the Content-Security-Policy violations of every page in `context` that is on
 * the app's origin (`appOrigin`): `securitypolicyviolation` events and the console errors the
 * browser logs for blocked resources. Other origins (Keycloak's pages) have their own policy.
 * Returns the list, which grows as the test runs.
 */
export async function watchCsp(context: BrowserContext, appOrigin: string): Promise<string[]> {
  const violations: string[] = [];
  const onApp = (url: string | undefined) => {
    try {
      return url !== undefined && new URL(url).origin === appOrigin;
    } catch {
      return false;
    }
  };
  await context.exposeFunction('__openrowsCspViolation', (violation: string) => {
    violations.push(violation);
  });
  await context.addInitScript(() => {
    document.addEventListener(
      'securitypolicyviolation',
      (e) => {
        if (new URL(e.documentURI).origin !== location.origin) return;
        window.__openrowsCspViolation?.(
          `${e.effectiveDirective} blocked ${e.blockedURI || '(inline)'} on ${e.documentURI}` +
            (e.sourceFile ? ` (${e.sourceFile}:${e.lineNumber})` : '')
        );
      },
      true
    );
  });
  context.on('console', (msg) => {
    if (msg.type() !== 'error' || !/Content Security Policy/i.test(msg.text())) return;
    if (onApp(msg.page()?.url())) violations.push(`console: ${msg.text()}`);
  });
  return violations;
}

/**
 * `test` for every spec: like Playwright's, plus a check that fails the test when a page of the
 * app reported a CSP violation. Use `watchCsp` for contexts a test opens itself.
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ context, baseURL }, use) => {
      const violations = await watchCsp(context, new URL(baseURL ?? 'http://localhost').origin);
      await use(violations);
      expect(violations, 'Content-Security-Policy violations').toEqual([]);
    },
    { auto: true },
  ],
});
