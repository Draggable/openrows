import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The cookie names of the inventory, docs/legal/cookies.md: the first cell of every table
 * row. The Privacy Policy promises only strictly necessary cookies, and that file says which.
 */
export function cookieInventory(): Set<string> {
  const text = readFileSync(
    fileURLToPath(new URL('../../docs/legal/cookies.md', import.meta.url)),
    'utf8'
  );
  return new Set([...text.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] ?? ''));
}
