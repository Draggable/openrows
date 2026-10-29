import { describe, expect, it } from 'vitest';
import {
  docBlocks,
  filterReference,
  groupReference,
  inlineParts,
  SDK_REFERENCE,
} from './sdk-model';

describe('the SDK reference model', () => {
  it('groups the generated reference, the client first', () => {
    const groups = groupReference(SDK_REFERENCE.items);
    expect(groups.map((g) => g.title)).toEqual([
      'Classes',
      'Functions',
      'Interfaces',
      'Types',
      'Constants',
      'Request and response types',
    ]);
    expect(groups[0]?.items[0]?.name).toBe('OpenRows');
    expect(groups.at(-1)?.items.every((i) => i.generated)).toBe(true);
  });

  it('splits doc comments into paragraphs and code', () => {
    expect(docBlocks('One\nline.\n\n```ts\nconst a = 1;\n```\nAfter.')).toEqual([
      { kind: 'text', text: 'One line.' },
      { kind: 'code', text: 'const a = 1;' },
      { kind: 'text', text: 'After.' },
    ]);
    expect(docBlocks('')).toEqual([]);
    expect(inlineParts('Use `select()` here')).toEqual([
      { code: false, text: 'Use ' },
      { code: true, text: 'select()' },
      { code: false, text: ' here' },
    ]);
  });

  it('filters by name, summary and member', () => {
    const names = (q: string) => filterReference(SDK_REFERENCE.items, q).map((i) => i.name);
    expect(names('upsert')).toContain('Table');
    expect(names('OpenRowsError')).toContain('OpenRowsError');
    expect(names('')).toHaveLength(SDK_REFERENCE.items.length);
  });
});
