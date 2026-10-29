#!/usr/bin/env node
// The product's name: `npm run lint:brand`, part of `npm run lint`.
// `node scripts/check-brand-name.mjs [root]` checks the repository it is in, or `root`.
//
// Users read "OpenRows" (capital O and R) everywhere. Lowercase `openrows` stays only where it is
// an identifier: domains (openrows.io), the npm scope (@openrows/sdk), package and CLI names
// (openrows-mcp-server), env vars, paths, container, realm and role names, storage keys. So this
// fails on any other spelling of the name (`openrows`, `Openrows`, `OPENROWS`) that isn't part of
// an identifier, in the text users read:
// - the client's JSX text and visible attributes (aria-label, alt, title, placeholder, label,
//   caption, description), toasts and document.title, in packages/client/src/**/*.tsx (tests
//   excluded);
// - packages/client/index.html's <title> and meta content, the web app manifest's names, and the
//   <title> of the brand SVGs (client public/, docs/design/brand/, the Keycloak theme);
// - emails: packages/server/src/email/, the unsubscribe pages (notifications/routes.ts), llms.txt
//   (docs/), and any server line that sets a `subject`;
// - the Keycloak theme's messages and templates (docker/keycloak/themes/**/*.{properties,ftl});
// - Markdown prose: the root's *.md, every README.md and docs/**/*.md, outside fenced code
//   blocks, inline code spans, link targets and autolinks.
// A match is part of an identifier when it is preceded by a letter, digit or one of `@ . / - _ :`,
// or followed by a letter, digit or one of `- _ /`, or by `.` or `:` and then a letter or digit
// (`openrows.io`, `@openrows/sdk`, `openrows-app`, `b_openrows`, `openrows:sha-1`).
// The hosted edition's marketing site (ee/site/, openrows.io) is left to its own build; it isn't
// part of the open-source tree.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'OpenRows';

const SKIP = new Set([
  'node_modules',
  'dist',
  'coverage',
  'legacy',
  '.git',
  '.cache',
  'playwright-report',
  'test-results',
]);
/** Paths (relative to the root, `/`-separated) never checked: the marketing site's own build. */
const IGNORED = ['ee/site/'];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** Whether the name at text[start, end) is part of an identifier (see the header). */
export function partOfIdentifier(text, start, end) {
  const before = text[start - 1] ?? '';
  const after = text[end] ?? '';
  const next = text[end + 1] ?? '';
  if (/[\p{L}\p{N}@./_:-]/u.test(before)) return true;
  if (/[\p{L}\p{N}_/-]/u.test(after)) return true;
  return /[.:]/.test(after) && /[\p{L}\p{N}]/u.test(next);
}

/** The misspelled names in `text`, as [{ index, found }] (index into `text`). */
export function misspellings(text) {
  const found = [];
  for (const match of text.matchAll(/openrows/gi)) {
    const start = match.index ?? 0;
    if (match[0] === NAME) continue;
    if (partOfIdentifier(text, start, start + match[0].length)) continue;
    found.push({ index: start, found: match[0] });
  }
  return found;
}

/** Blanks a span (keeps newlines, so line numbers and offsets hold). */
function blank(span) {
  return span.replace(/[^\n]/g, ' ');
}

/** The text with block comments and whole-line `//` comments blanked (TS, TSX, JS). */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

/** Regions of a client component users read: [{ index, text }]. */
export function tsxRegions(source) {
  const text = withoutComments(source);
  const regions = [];
  const quoted = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;
  const patterns = [
    // JSX text: after a tag's `>`, up to the next tag or expression.
    { re: />([^<>{}]+)(?=[<{])/g, group: 1, tail: 0 },
    // Visible attributes, as "…", '…', {'…'} or {`…`}.
    {
      re: new RegExp(
        String.raw`\b(?:aria-label|alt|title|placeholder|label|caption|description)\s*=\s*\{?\s*${quoted}`,
        'g'
      ),
      group: 2,
      tail: 1,
    },
    // Toasts and page titles.
    { re: new RegExp(String.raw`\btoast(?:\.\w+)?\(\s*${quoted}`, 'g'), group: 2, tail: 1 },
    { re: new RegExp(String.raw`\bdocument\.title\s*=\s*${quoted}`, 'g'), group: 2, tail: 1 },
  ];
  for (const { re, group, tail } of patterns) {
    for (const m of text.matchAll(re)) {
      const inner = m[group] ?? '';
      regions.push({ index: (m.index ?? 0) + m[0].length - inner.length - tail, text: inner });
    }
  }
  return regions;
}

/** index.html: the <title> and every meta tag's content. */
export function htmlRegions(source) {
  const text = source.replace(/<!--[\s\S]*?-->/g, blank);
  const regions = [];
  for (const m of text.matchAll(/<title>([^<]*)<\/title>/g)) {
    regions.push({ index: (m.index ?? 0) + '<title>'.length, text: m[1] ?? '' });
  }
  for (const m of text.matchAll(/<meta\b[^>]*?\bcontent="([^"]*)"/g)) {
    const inner = m[1] ?? '';
    regions.push({ index: (m.index ?? 0) + m[0].length - inner.length - 1, text: inner });
  }
  return regions;
}

/** An SVG's <title>, its accessible name. */
export function svgRegions(source) {
  return [...source.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => ({
    index: (m.index ?? 0) + '<title>'.length,
    text: m[1] ?? '',
  }));
}

/** The web app manifest's names and description. */
export function manifestRegions(source) {
  return [...source.matchAll(/"(?:name|short_name|description)"\s*:\s*"((?:\\.|[^"\\])*)"/g)].map(
    (m) => {
      const inner = m[1] ?? '';
      return { index: (m.index ?? 0) + m[0].length - inner.length - 1, text: inner };
    }
  );
}

/** A whole source with its comments blanked (email templates, llms.txt). */
export function codeRegions(source) {
  return [{ index: 0, text: withoutComments(source) }];
}

/** The lines of a server source that set an email's subject. */
export function subjectRegions(source) {
  const text = withoutComments(source);
  const regions = [];
  let index = 0;
  for (const line of text.split('\n')) {
    if (/\bsubject\b/i.test(line)) regions.push({ index, text: line });
    index += line.length + 1;
  }
  return regions;
}

/**
 * Markdown prose: outside fenced code blocks, inline code spans (which may wrap within a
 * paragraph), link targets, autolinks and HTML comments.
 */
export function markdownRegions(source) {
  let fence = null;
  const lines = source.split('\n').map((line) => {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length) fence = null;
      return blank(line);
    }
    if (open) {
      fence = open;
      return blank(line);
    }
    return line;
  });
  // Code spans stay inside a block: a paragraph (lines up to a blank one) or one table row.
  const blocks = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    const row = /^\s*\|/.test(line);
    if (last !== undefined && !row && line.trim() !== '' && !last.row && last.text.trim() !== '') {
      last.text += `\n${line}`;
    } else {
      blocks.push({ row, text: line });
    }
  }
  const text = blocks
    .map((b) => b.text.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, blank))
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\]\([^)]*\)/g, blank)
    .replace(/<[a-z][a-z0-9+.-]*:[^>\s]*>/gi, blank);
  return [{ index: 0, text }];
}

const KEYCLOAK_THEMES = 'docker/keycloak/themes';
const SVG_DIRS = ['packages/client/public', 'docs/design/brand', KEYCLOAK_THEMES];

/** Which regions of `file` (a `/`-separated path relative to the root) users read, if any. */
export function scannerFor(file) {
  if (IGNORED.some((p) => file.startsWith(p))) return null;
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (file.endsWith('.md')) {
    if (!file.includes('/') || name === 'README.md' || file.startsWith('docs/')) {
      return markdownRegions;
    }
    return null;
  }
  if (
    file.startsWith('packages/client/src/') &&
    /\.tsx$/.test(file) &&
    !/\.test\.tsx$/.test(file)
  ) {
    return tsxRegions;
  }
  if (file === 'packages/client/index.html') return htmlRegions;
  if (file === 'packages/client/public/site.webmanifest') return manifestRegions;
  if (file.endsWith('.svg') && SVG_DIRS.some((d) => file.startsWith(`${d}/`))) return svgRegions;
  if (file.startsWith(`${KEYCLOAK_THEMES}/`) && /\.(?:properties|ftl)$/.test(file)) {
    return codeRegions;
  }
  if (file.startsWith('packages/server/src/') && /\.ts$/.test(file) && !/\.test\.ts$/.test(file)) {
    if (
      file.startsWith('packages/server/src/email/') ||
      file.startsWith('packages/server/src/docs/') ||
      file === 'packages/server/src/notifications/routes.ts'
    ) {
      return codeRegions;
    }
    return subjectRegions;
  }
  return null;
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - before.lastIndexOf('\n') };
}

/** Every misspelled name under `root`, as { file, line, column, found, message }. */
export function checkBrandName(root) {
  const problems = [];
  // The root's own *.md (not symlinks: AGENTS.md is CLAUDE.md), then the trees with user text.
  const files = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => join(root, e.name));
  for (const dir of ['packages', 'docs', 'docker', 'ee']) files.push(...walk(join(root, dir)));
  for (const path of files) {
    const file = relative(root, path).split(sep).join('/');
    const scan = scannerFor(file);
    if (!scan || lstatSync(path).isSymbolicLink()) continue;
    const text = readFileSync(path, 'utf8');
    const seen = new Set();
    for (const region of scan(text)) {
      for (const m of misspellings(region.text)) {
        const index = region.index + m.index;
        if (seen.has(index)) continue;
        seen.add(index);
        problems.push({
          file,
          ...lineAndColumn(text, index),
          found: m.found,
          message: `"${m.found}": users read the name as "${NAME}"`,
        });
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The repository this script is in, or the directory given (the tests' fixtures).
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const problems = checkBrandName(root);
  for (const p of problems) console.error(`${p.file}:${p.line}:${p.column}: ${p.message}`);
  if (problems.length > 0) {
    console.error(
      `\nbrand name: ${problems.length} problem(s). Write "${NAME}" where users read it; lowercase openrows only in identifiers (domains, @openrows/ packages, paths, names in code).`
    );
    process.exit(1);
  }
  console.log(`brand name: ok (users read "${NAME}")`);
}
