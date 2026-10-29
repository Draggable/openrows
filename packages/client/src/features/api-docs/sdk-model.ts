import reference from './sdk-reference.json';

/**
 * The JavaScript SDK's reference for /docs/api/sdk: `sdk-reference.json`, written by
 * TypeDoc from packages/sdk (`npm run generate -w @openrows/sdk`), grouped for the page, and doc
 * comments split into paragraphs and code blocks (rendered as text, never as HTML).
 */

/** The shapes packages/sdk/scripts/reference.ts writes. */
export interface ReferenceMember {
  name: string;
  kind: 'constructor' | 'method' | 'property' | 'accessor';
  signatures: string[];
  summary: string;
}

export interface ReferenceItem {
  name: string;
  kind: 'class' | 'interface' | 'type' | 'function' | 'variable';
  summary: string;
  signatures: string[];
  members: ReferenceMember[];
  generated: boolean;
}

export interface Reference {
  package: string;
  version: string;
  items: ReferenceItem[];
}

export const SDK_REFERENCE = reference as Reference;

export interface ReferenceGroup {
  id: string;
  title: string;
  items: ReferenceItem[];
}

const GROUPS: [string, string, (i: ReferenceItem) => boolean][] = [
  ['sdk-classes', 'Classes', (i) => i.kind === 'class'],
  ['sdk-functions', 'Functions', (i) => i.kind === 'function'],
  ['sdk-interfaces', 'Interfaces', (i) => i.kind === 'interface'],
  ['sdk-types', 'Types', (i) => i.kind === 'type' && !i.generated],
  ['sdk-constants', 'Constants', (i) => i.kind === 'variable'],
  ['sdk-generated', 'Request and response types', (i) => i.kind === 'type' && i.generated],
];

/** The reference's items in the page's groups, in order; empty groups left out. */
export function groupReference(items: readonly ReferenceItem[]): ReferenceGroup[] {
  return GROUPS.map(([id, title, test]) => ({ id, title, items: items.filter(test) })).filter(
    (g) => g.items.length > 0
  );
}

/** An anchor for an item: `#sdk-Table`. */
export const itemId = (name: string) => `sdk-${name}`;

export type DocBlock = { kind: 'text'; text: string } | { kind: 'code'; text: string };

/** A doc comment as paragraphs and fenced code blocks. */
export function docBlocks(summary: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const parts = summary.split(/```[a-z]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const text = part.replace(/\n$/, '');
      if (text) blocks.push({ kind: 'code', text });
      return;
    }
    for (const paragraph of part.split(/\n\s*\n/)) {
      const text = paragraph.trim().replace(/\s*\n\s*/g, ' ');
      if (text) blocks.push({ kind: 'text', text });
    }
  });
  return blocks;
}

export type InlinePart = { code: boolean; text: string };

/** A paragraph's `code` spans. */
export function inlineParts(text: string): InlinePart[] {
  return text
    .split('`')
    .map((t, i) => ({ code: i % 2 === 1, text: t }))
    .filter((p) => p.text !== '');
}

/** Items whose name or summary has every word of `query`. */
export function filterReference(items: readonly ReferenceItem[], query: string): ReferenceItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((i) => {
    const hay = [i.name, i.summary, ...i.members.map((m) => m.name)].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
