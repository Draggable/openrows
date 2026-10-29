import { FIELD_TYPE_NAMES, getFieldType } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { mapperType, READ_ONLY_TYPES, SEARCHABLE_TYPES } from './schema';

/** The node keeps its own copies of what the server's field registry says (no runtime deps). */
describe('field types', () => {
  it('leaves out of writes exactly the read-only types of the registry', () => {
    const readOnly = FIELD_TYPE_NAMES.filter((name) => getFieldType(name).readOnly).sort();
    expect([...READ_ONLY_TYPES].sort()).toEqual(readOnly);
  });

  it('names only real types', () => {
    for (const name of SEARCHABLE_TYPES) expect(FIELD_TYPE_NAMES).toContain(name);
    expect(FIELD_TYPE_NAMES.map(mapperType).every((t) => typeof t === 'string')).toBe(true);
  });
});
