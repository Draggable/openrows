import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('.', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Any spelling of the name but "OpenRows" that isn't part of an identifier (openrows.io,
 * @openrows/shared, openrows:outbox-relay:); scripts/check-brand-name.mjs has the same rule for
 * the text users read across the repository.
 */
const MISSPELLED =
  /(?<![\p{L}\p{N}@./_:-])(?!OpenRows)[Oo][Pp][Ee][Nn][Rr][Oo][Ww][Ss](?![\p{L}\p{N}_/-]|[.:][\p{L}\p{N}])/gu;

/**
 * emails, the unsubscribe pages, file names, logs and the API document name the
 * product as the client does, "OpenRows" (`BRAND`, DESIGN.md §2).
 */
describe('the brand name in server output', () => {
  const files = sources(root).map((path) => ({
    name: relative(root, path),
    text: readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      // Key derivation salts are identifiers: changing them would void every cookie and token.
      .replace(/\bhkdfSync\([^)]*\)/g, ''),
  }));

  it('scans the sources', () => {
    expect(files.map((f) => f.name)).toContain('email/templates.ts');
  });

  it('is never spelled another way', () => {
    expect(
      files.flatMap((f) => (f.text.match(MISSPELLED) ?? []).map((m) => `${f.name}: ${m}`))
    ).toEqual([]);
  });
});
