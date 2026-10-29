import { describe, expect, it } from 'vitest';
import { answerChoice, cellStates, statusSummary } from './model';

const select = {
  options: {
    output: 'singleSelect',
    choices: [
      { id: 'c1', name: 'Bug', color: 'red' },
      { id: 'c2', name: 'Feature', color: 'green' },
    ],
  },
};

describe('AI field model (#149)', () => {
  it('finds the choice a select answer names', () => {
    expect(answerChoice(select, 'Feature')?.id).toBe('c2');
    expect(answerChoice(select, 'Gone')).toBeNull();
    expect(answerChoice({ options: {} }, 'Feature')).toBeNull();
  });

  it('maps cells and sums up the state', () => {
    const status = {
      fieldId: '01900000-0000-7000-8000-000000000001',
      available: true,
      counts: { pending: 2, done: 5, error: 1, canceled: 0 },
      cells: [
        {
          recordId: 'r1',
          status: 'error' as const,
          error: 'Nope',
          updatedAt: '2026-10-28T00:00:00.000Z',
        },
      ],
    };
    expect(cellStates(status).get('r1')).toEqual({ status: 'error', error: 'Nope' });
    expect(statusSummary(status)).toBe('2 generating, 1 failed');
    expect(
      statusSummary({ ...status, counts: { pending: 0, done: 5, error: 0, canceled: 0 } })
    ).toBeNull();
  });
});
