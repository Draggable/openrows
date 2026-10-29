import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateReference, REFERENCE_PATH, serialize } from './reference.js';

describe('the SDK reference (/docs/api/sdk)', () => {
  it('is current (run `npm run generate -w @openrows/sdk` after changing the SDK)', async () => {
    const reference = await generateReference();
    expect(readFileSync(REFERENCE_PATH, 'utf8')).toBe(serialize(reference));
    const names = reference.items.map((i) => i.name);
    expect(names.slice(0, 2)).toEqual(['OpenRows', 'BaseClient']);
    expect(names).toEqual(expect.arrayContaining(['OpenRowsError', 'ClientOptions', 'Webhook']));
    const table = reference.items.find((i) => i.name === 'Table');
    expect(table?.members.map((m) => m.name)).toEqual(
      expect.arrayContaining(['select', 'create', 'update', 'replace', 'upsert', 'destroy'])
    );
    // Nothing internal or private reaches the page.
    const client = reference.items.find((i) => i.name === 'OpenRows');
    expect(client?.members.map((m) => m.name)).not.toContain('http');
  }, 30_000);
});
