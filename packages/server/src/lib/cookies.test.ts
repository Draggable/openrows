import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOGIN_COOKIE } from '../auth/routes.js';
import { SESSION_COOKIE } from '../auth/session-token.js';
import { SHARE_ACCESS_COOKIE } from '../shares/access.js';
import { SYNC_CONNECT_COOKIE } from '../syncs/connector-routes.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
const INVENTORY = join(ROOT, 'docs/legal/cookies.md');

/** The cookie names in docs/legal/cookies.md: the first cell of every table row. */
function inventory(): Set<string> {
  const names = [...readFileSync(INVENTORY, 'utf8').matchAll(/^\| `([^`]+)` \|/gm)];
  return new Set(names.map((m) => m[1] ?? ''));
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

// The cookie inventory is what the Privacy Policy promises: only cookies needed to keep you
// signed in and secure. e2e/cookies.spec.ts checks the browser's cookies after a sign-in; this
// checks the server's own names, including ones no spec sets.
describe('the cookie inventory', () => {
  it('lists every cookie the server sets', () => {
    const listed = inventory();
    for (const name of [SESSION_COOKIE, LOGIN_COOKIE, SHARE_ACCESS_COOKIE, SYNC_CONNECT_COOKIE]) {
      expect(listed, name).toContain(name);
    }
  });

  it('knows every cookie name the server defines or sets', () => {
    const listed = inventory();
    const src = join(ROOT, 'packages/server/src');
    const found: string[] = [];
    for (const file of sources(src)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/export const \w*COOKIE\w* = '([^']+)'/g))
        found.push(m[1] ?? '');
      // setCookie with a literal name, or with a constant other than the ones above.
      for (const m of text.matchAll(/setCookie\(\s*c,\s*([^,]+),/g)) {
        const arg = (m[1] ?? '').trim();
        if (/^'[^']+'$/.test(arg)) found.push(arg.slice(1, -1));
        else
          expect(
            ['SESSION_COOKIE', 'LOGIN_COOKIE', 'SHARE_ACCESS_COOKIE', 'SYNC_CONNECT_COOKIE'],
            `${file}: ${arg}`
          ).toContain(arg);
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const name of found) expect(listed, name).toContain(name);
  });
});
