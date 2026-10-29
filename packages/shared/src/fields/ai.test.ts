import { describe, expect, it } from 'vitest';
import {
  AI_MAX_INPUT_VALUE,
  aiGenerateSchema,
  aiOptionsSchema,
  displayAiPrompt,
  parseAiPrompt,
  renderAiPrompt,
  storeAiPrompt,
} from './ai.js';
import { getFieldType } from './index.js';

const NAME = '01900000-0000-7000-8000-000000000001';
const NOTES = '01900000-0000-7000-8000-000000000002';
const FIELDS = [
  { id: NAME, name: 'Name' },
  { id: NOTES, name: 'Notes' },
];

describe('AI prompt templates (#149)', () => {
  it('splits text and tokens, with escaped braces as text', () => {
    expect(parseAiPrompt('Summarize {Notes} for \\{x\\} {unclosed')).toEqual([
      { text: 'Summarize ' },
      { token: 'Notes' },
      { text: ' for {x} {unclosed' },
    ]);
  });

  it('stores fields by id and shows them by name again', () => {
    const stored = storeAiPrompt('Tag {name}: {Notes} and {Notes} \\{json\\}', FIELDS);
    expect(stored).toEqual({
      ok: true,
      prompt: `Tag {${NAME}}: {${NOTES}} and {${NOTES}} \\{json\\}`,
      referencedFieldIds: [NAME, NOTES],
    });
    if (!stored.ok) return;
    expect(displayAiPrompt(stored.prompt, FIELDS)).toBe(
      'Tag {Name}: {Notes} and {Notes} \\{json\\}'
    );
    // The stored form is accepted as input too.
    expect(storeAiPrompt(stored.prompt, FIELDS)).toEqual(stored);
    // A renamed field keeps its place.
    expect(displayAiPrompt(stored.prompt, [{ id: NAME, name: 'Title' }])).toContain('{Title}');
  });

  it('refuses tokens that name no field', () => {
    expect(storeAiPrompt('Use {Nope}', FIELDS)).toEqual({
      ok: false,
      message: 'No field named "Nope". Write \\{ for a literal brace.',
    });
    expect(storeAiPrompt('Empty {}', FIELDS).ok).toBe(false);
  });

  it('fills a template with values, cut to the cap', () => {
    const long = 'x'.repeat(AI_MAX_INPUT_VALUE + 10);
    const out = renderAiPrompt(`A {${NAME}} B {${NOTES}} \\{`, (id) => (id === NAME ? 'n' : long));
    expect(out).toBe(`A n B ${'x'.repeat(AI_MAX_INPUT_VALUE)} {`);
  });
});

describe('the ai field type (#149)', () => {
  const def = getFieldType('ai');
  const select = aiOptionsSchema.parse({
    output: 'singleSelect',
    choices: [
      { id: 'c1', name: 'Bug', color: 'red' },
      { id: 'c2', name: 'Feature', color: 'green' },
    ],
  });

  it('reads a select answer as one of the choices, or empty', () => {
    expect(def.coerce('bug', select)).toBe('Bug');
    expect(def.coerce(' Feature ', select)).toBe('Feature');
    expect(def.coerce('c2', select)).toBe('Feature');
    expect(def.coerce('Question', select)).toBeNull();
    // A stored name whose choice was deleted reads as empty.
    expect(def.fromStorage('Gone', select)).toBeNull();
  });

  it('reads numbers with the precision, and texts as text', () => {
    const number = aiOptionsSchema.parse({ output: 'number', precision: 1 });
    expect(def.coerce('1,234.56', number)).toBe(1234.6);
    expect(def.coerce('many', number)).toBeNull();
    expect(def.format(1234.5, number)).toBe('1,234.5');
    const text = aiOptionsSchema.parse({});
    expect(def.coerce('  ', text)).toBeNull();
    expect(def.coerce('Hello', text)).toBe('Hello');
  });

  it('keeps the prompt out of share links', () => {
    expect(def.publicOptions?.(aiOptionsSchema.parse({ prompt: 'secret' }))).toEqual({
      output: 'text',
      choices: [],
      precision: null,
    });
  });

  it('takes records or a scope to generate', () => {
    expect(aiGenerateSchema.safeParse({ scope: 'all' }).success).toBe(true);
    expect(aiGenerateSchema.safeParse({ recordIds: [NAME] }).success).toBe(true);
    expect(aiGenerateSchema.safeParse({ recordIds: [] }).success).toBe(false);
    expect(aiGenerateSchema.safeParse({ scope: 'all', recordIds: [NAME] }).success).toBe(false);
  });
});
