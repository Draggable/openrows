import type { FieldMeta, RecordData, RowColor } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { colorableFields, colorConditionsOf, newColorCondition, rowColorOf } from './model';

const stage = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Stage',
  type: 'singleSelect',
  options: {
    choices: [
      { id: 'todo', name: 'To do', color: 'blue' },
      { id: 'done', name: 'Done', color: 'green' },
    ],
  },
  deletedAt: null,
} as unknown as FieldMeta;
const points = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Points',
  type: 'number',
  options: {},
  deletedAt: null,
} as unknown as FieldMeta;
const record = (fields: Record<string, unknown>, id = 'r1') => ({ id, fields }) as RecordData;

describe('row colours (#42)', () => {
  it('colours by the choice of a single select', () => {
    const rowColor: RowColor = { mode: 'select', fieldId: stage.id };
    expect(colorableFields([stage, points])).toEqual([stage]);
    expect(rowColorOf(record({ [stage.id]: 'done' }), rowColor, [stage], undefined)).toBe('green');
    expect(rowColorOf(record({}), rowColor, [stage], undefined)).toBeUndefined();
    expect(rowColorOf(record({ [stage.id]: 'gone' }), rowColor, [stage], undefined)).toBe(
      undefined
    );
  });

  it("colours by conditions with the server's answer, sending finished conditions only", () => {
    const done = {
      color: 'red' as const,
      filter: {
        conjunction: 'and' as const,
        conditions: [{ fieldId: points.id, operator: '>' as const, value: 3 }],
      },
    };
    const unfinished = {
      color: 'amber' as const,
      filter: {
        conjunction: 'and' as const,
        conditions: [{ fieldId: points.id, operator: '>' as const }],
      },
    };
    const rowColor: RowColor = { mode: 'conditions', conditions: [done, unfinished] };
    expect(colorConditionsOf(rowColor)).toEqual([done]);
    expect(colorConditionsOf({ mode: 'select', fieldId: stage.id })).toEqual([]);
    expect(colorConditionsOf(null)).toEqual([]);
    expect(rowColorOf(record({}, 'r1'), rowColor, [points], { r1: 'red' })).toBe('red');
    expect(rowColorOf(record({}, 'r2'), rowColor, [points], { r1: 'red' })).toBeUndefined();
  });

  it('starts a new condition with the next colour on the first field', () => {
    expect(newColorCondition([points], 1, ['green', 'amber'])).toEqual({
      color: 'amber',
      filter: { conjunction: 'and', conditions: [{ fieldId: points.id, operator: '=' }] },
    });
    expect(newColorCondition([], 0, ['green'])).toBeNull();
  });
});
