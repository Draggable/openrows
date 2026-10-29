import { describe, expect, it } from 'vitest';
import { BRAND } from './Logo';

/** Every client source file (tests excluded) and index.html, as text, by path. */
const raw = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '../../index.html'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Any spelling of the name but "OpenRows" that isn't part of an identifier (openrows.io,
 * @openrows/sdk, openrows-theme, openrows:airtable-watch); scripts/check-brand-name.mjs has the
 * same rule for the text users read across the repository.
 */
const MISSPELLED =
  /(?<![\p{L}\p{N}@./_:-])(?!OpenRows)[Oo][Pp][Ee][Nn][Rr][Oo][Ww][Ss](?![\p{L}\p{N}_/-]|[.:][\p{L}\p{N}])/gu;

/**
 * the UI writes the product's name one way, "OpenRows" (DESIGN.md §2, `BRAND` in
 * @openrows/shared): "Made with OpenRows" on forms and shared views alike, page titles too.
 */
describe('the brand name', () => {
  const files = Object.entries(raw).map(([path, text]) => ({
    name: path,
    text: text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      // The MCP server's name in the docs' client configs and the SDK samples' variable
      // are identifiers, not the name.
      .replace(
        /claude mcp add (?:--transport http )?openrows\b|\bopenrows: \{|const openrows =/g,
        ''
      ),
  }));

  it('is "OpenRows"', () => {
    expect(BRAND).toBe('OpenRows');
  });

  it('scans the sources', () => {
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        './Logo.tsx',
        '../../index.html',
        '../features/share/PublicFormPage.tsx',
      ])
    );
  });

  it('is never spelled another way in code and markup', () => {
    expect(
      files.flatMap((f) => (f.text.match(MISSPELLED) ?? []).map((m) => `${f.name}: ${m}`))
    ).toEqual([]);
  });
});
