import { describe, expect, it } from 'vitest';
import {
  countSteps,
  renumberStepTokens,
  stepAddressText,
  stepAt,
  stepTokenProblem,
  tokenStepAddress,
  walkSteps,
} from './steps.js';
import { parsePath } from './template.js';

const leaf = (name: string) => ({ type: 'createRecord', name });
const tree = [
  leaf('a'),
  {
    type: 'branch',
    // biome-ignore lint/suspicious/noThenProperty: a list of steps (an array, never a function)
    then: [leaf('b'), { type: 'repeat', actions: [leaf('c')] }],
    otherwise: [],
  },
  leaf('d'),
];

describe('the step tree', () => {
  it('walks steps in run order with their addresses, paths and depths', () => {
    expect(
      walkSteps(tree).map((s) => [stepAddressText(s.address), s.path.join('.'), s.depth])
    ).toEqual([
      ['1', '0', 1],
      ['2', '1', 1],
      ['2.then.1', '1.then.0', 2],
      ['2.then.2', '1.then.1', 2],
      ['2.then.2.actions.1', '1.then.1.actions.0', 3],
      ['3', '2', 1],
    ]);
    expect(countSteps(tree)).toBe(6);
  });

  it('finds a step by address', () => {
    expect(stepAt(tree, [2, 'then', 2, 'actions', 1])).toEqual(leaf('c'));
    expect(stepAt(tree, [2, 'otherwise', 1])).toBeUndefined();
    expect(stepAt(tree, [1, 'then', 1])).toBeUndefined();
  });

  it("reads a token's step address along the tree, not through outputs", () => {
    const at = (token: string) => tokenStepAddress(tree, parsePath(token));
    expect(at('steps.2.then.2.actions.1.record.id')).toEqual([2, 'then', 2, 'actions', 1]);
    expect(at('steps.2.path')).toEqual([2]);
    // A leaf's output may have such keys; they stay output.
    expect(at('steps.1.then.1')).toEqual([1]);
    expect(at('trigger.record.id')).toBeNull();
  });

  it('keeps the existing message for top-level steps', () => {
    expect(stepTokenProblem(tree, parsePath('steps.3.id'), [2])).toBe(
      'Step 2 can only use the steps before it.'
    );
    expect(stepTokenProblem(tree, parsePath('trigger.record'), null)).toBe(
      "Tokens can't be used in the trigger."
    );
    expect(stepTokenProblem(tree, parsePath('steps.2.then.1.id'), [3])).toBeNull();
    expect(
      stepTokenProblem(tree, parsePath('steps.2.then.2.item'), [2, 'then', 2, 'actions', 1])
    ).toBeNull();
  });
});

describe('renumberStepTokens', () => {
  it('rewrites only the numbers of the reordered list, as written', () => {
    const actions = [
      {
        type: 'createRecord',
        fields: { a: 'x {{steps.1.id}} {{ steps[2].then[1].id }} {{steps.2.then.2.records[0]}}' },
      },
      { type: 'runScript', script: "'{{steps.1.id}}'", inputs: { v: '{{steps.1.id}}' } },
    ];
    // Step 2's Then: 1 ↔ 2.
    const swapped = renumberStepTokens(actions, [2, 'then'], (n) =>
      n === 1 ? 2 : n === 2 ? 1 : n
    );
    expect(swapped[0]?.fields).toEqual({
      a: 'x {{steps.1.id}} {{ steps[2].then[2].id }} {{steps.2.then.1.records[0]}}',
    });
    // The top level: 1 → 3; a script's code is never touched.
    const top = renumberStepTokens(actions, [], (n) => (n === 1 ? 3 : n));
    expect(top[0]).toMatchObject({
      fields: { a: 'x {{steps.3.id}} {{ steps[2].then[1].id }} {{steps.2.then.2.records[0]}}' },
    });
    expect(top[1]).toEqual({
      type: 'runScript',
      script: "'{{steps.1.id}}'",
      inputs: { v: '{{steps.3.id}}' },
    });
    // Malformed tokens stay.
    expect(renumberStepTokens('{{steps..1}}', [], () => 9)).toBe('{{steps..1}}');
  });
});
