import { describe, expect, it } from 'vitest';

/**
 * Every client source file (tests excluded), as text, keyed by its path from this folder. The
 * service worker (src/sw) is left out: it doesn't call the API, it answers the app's calls.
 */
const raw = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../sw/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * the client reaches the API only through the typed contract client (`api/client.ts`), so
 * no URL is written by hand (the prototype had `/api/api/...` in about 60 places).
 */
describe('client sources', () => {
  const files = Object.entries(raw).map(([path, text]) => ({
    name: path,
    // Comments may name endpoints; code may not.
    text: text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  }));

  it('are found', () => {
    expect(files.map((f) => f.name)).toContain('./client.ts');
  });

  it('call fetch only in api/client.ts', () => {
    const callers = files.filter((f) => /\bfetch\s*\(/.test(f.text)).map((f) => f.name);
    expect(callers).toEqual(['./client.ts']);
  });

  it('contain no hand-written /api URLs', () => {
    const offenders = files.filter((f) => /['"`]\/api[/'"`]/.test(f.text)).map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});
