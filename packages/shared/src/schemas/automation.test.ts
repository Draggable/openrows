import { describe, expect, it } from 'vitest';
import { createAutomationSchema, MAX_SCRIPT_INPUTS, MAX_SCRIPT_LENGTH } from './automation.js';

const trigger = { type: 'recordCreated', tableId: '01a17db5-dd06-713a-bc40-74cc8eb80a47' };
const parse = (action: Record<string, unknown>) =>
  createAutomationSchema.safeParse({ name: 'A', trigger, actions: [action] });
const paths = (r: ReturnType<typeof parse>) =>
  r.success ? [] : r.error.issues.map((i) => i.path.join('.'));

describe('run-script actions (#112)', () => {
  it('takes a script and input variables, defaulting to none', () => {
    const r = parse({ type: 'runScript', script: 'output.set("a", 1)' });
    expect(r.success && r.data.actions[0]).toEqual({
      type: 'runScript',
      script: 'output.set("a", 1)',
      inputs: {},
    });
  });

  it('checks tokens in the inputs only: the script is code, never filled in', () => {
    const code = "// {{steps.9.output}} and {{nonsense in a comment\nconst s = '{{x}}';";
    expect(paths(parse({ type: 'runScript', script: code }))).toEqual([]);
    expect(
      paths(parse({ type: 'runScript', script: 'x', inputs: { id: '{{steps.1.records}}' } }))
    ).toEqual(['actions.0']);
    expect(
      paths(parse({ type: 'runScript', script: 'x', inputs: { id: '{{trigger.record.id}}' } }))
    ).toEqual([]);
  });

  it('caps the script, the inputs and their names', () => {
    expect(paths(parse({ type: 'runScript', script: '' }))).toEqual(['actions.0.script']);
    expect(
      paths(parse({ type: 'runScript', script: 'x'.repeat(MAX_SCRIPT_LENGTH + 1) }))
    ).toContain('actions.0.script');
    expect(paths(parse({ type: 'runScript', script: 'x', inputs: { 'not ok': 'v' } }))).toEqual([
      'actions.0.inputs.not ok',
    ]);
    // Zod leaves a `__proto__` key out; `constructor` and `prototype` are refused.
    const proto = parse({
      type: 'runScript',
      script: 'x',
      inputs: JSON.parse('{"__proto__": "v"}'),
    });
    expect(
      proto.success &&
        Object.keys(proto.data.actions[0]?.type === 'runScript' ? proto.data.actions[0].inputs : {})
    ).toEqual([]);
    expect(paths(parse({ type: 'runScript', script: 'x', inputs: { constructor: 'v' } }))).toEqual([
      'actions.0.inputs.constructor',
    ]);
    const many = Object.fromEntries(
      Array.from({ length: MAX_SCRIPT_INPUTS + 1 }, (_, i) => [`v${i}`, 'x'])
    );
    expect(paths(parse({ type: 'runScript', script: 'x', inputs: many }))).toEqual([
      'actions.0.inputs',
    ]);
  });
});
