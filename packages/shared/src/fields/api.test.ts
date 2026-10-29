import { describe, expect, it } from 'vitest';
import { apiTypeOf, apiValueOf, fieldTypeForApi } from './index.js';
import type { ApiValueContext } from './types.js';

const ctx: ApiValueContext = {
  user: (id) => ({ id, name: `User ${id}` }),
  fileUrl: (id) => `https://files.test/${id}`,
};
const choices = [
  { id: 'c1', name: 'Todo', color: 'blue' },
  { id: 'c2', name: 'Done', color: 'green' },
];

describe('the REST API view of fields (#103)', () => {
  it('names types as Airtable does where they differ', () => {
    expect(apiTypeOf({ type: 'link', options: {} })).toBe('multipleRecordLinks');
    expect(apiTypeOf({ type: 'longText', options: { richText: true } })).toBe('richText');
    expect(apiTypeOf({ type: 'user', options: { multiple: true } })).toBe('multipleCollaborators');
    expect(apiTypeOf({ type: 'number', options: {} })).toBe('number');
    expect(fieldTypeForApi('multipleSelects')).toBe('multipleSelect');
    expect(fieldTypeForApi('phoneNumber')).toBe('phone');
    expect(fieldTypeForApi('singleLineText')).toBe('singleLineText');
    expect(fieldTypeForApi('aiText')).toBe('ai');
  });

  it('shows cells in Airtable’s json format', () => {
    expect(apiValueOf({ type: 'singleSelect', options: { choices } }, 'c2', ctx)).toBe('Done');
    expect(apiValueOf({ type: 'multipleSelect', options: { choices } }, ['c1', 'c2'], ctx)).toEqual(
      ['Todo', 'Done']
    );
    expect(apiValueOf({ type: 'link', options: {} }, [{ id: 'r1', name: 'One' }], ctx)).toEqual([
      'r1',
    ]);
    expect(apiValueOf({ type: 'user', options: { multiple: false } }, ['u1'], ctx)).toEqual({
      id: 'u1',
      name: 'User u1',
    });
    expect(apiValueOf({ type: 'createdBy', options: {} }, 'u2', ctx)).toEqual({
      id: 'u2',
      name: 'User u2',
    });
    expect(
      apiValueOf(
        { type: 'attachment', options: {} },
        [{ id: 'a1', filename: 'x.png', size: 3, type: 'image/png' }],
        ctx
      )
    ).toEqual([
      { id: 'a1', filename: 'x.png', size: 3, type: 'image/png', url: 'https://files.test/a1' },
    ]);
    expect(apiValueOf({ type: 'number', options: {} }, 4, ctx)).toBe(4);
    expect(apiValueOf({ type: 'checkbox', options: {} }, false, ctx)).toBeNull();
    expect(apiValueOf({ type: 'singleLineText', options: {} }, null, ctx)).toBeNull();
  });
});
