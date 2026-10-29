import type { PublicForm } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import {
  fieldErrors,
  formFieldMeta,
  formUrl,
  initialAnswers,
  linkAnswerOf,
  missingAnswers,
  pickLink,
  redirectTarget,
  submissionFields,
} from './form-model';

const NAME = '01900000-0000-7000-8000-000000000001';
const KIND = '01900000-0000-7000-8000-000000000002';
const DETAILS = '01900000-0000-7000-8000-000000000003';
const AGE = '01900000-0000-7000-8000-000000000004';

const form: PublicForm = {
  title: 'Report',
  description: null,
  hasCover: false,
  hasLogo: false,
  submitLabel: 'Send',
  afterSubmit: 'message',
  submitMessage: null,
  redirectUrl: null,
  showBranding: true,
  captchaSiteKey: null,
  accepting: true,
  entries: [
    { fieldId: NAME, required: true, allowPrefill: true },
    { fieldId: KIND, allowPrefill: true },
    {
      fieldId: DETAILS,
      required: true,
      condition: {
        conjunction: 'and',
        conditions: [{ fieldId: KIND, operator: 'is', value: 'bug' }],
      },
    },
    { fieldId: AGE, allowPrefill: true },
  ],
  fields: [
    { id: NAME, name: 'Name', type: 'singleLineText', options: {}, isPrimary: true },
    {
      id: KIND,
      name: 'Kind',
      type: 'singleSelect',
      options: {
        choices: [
          { id: 'bug', name: 'Bug', color: 'red' },
          { id: 'idea', name: 'Idea', color: 'green' },
        ],
      },
      isPrimary: false,
    },
    { id: DETAILS, name: 'Details', type: 'longText', options: {}, isPrimary: false },
    { id: AGE, name: 'Age', type: 'number', options: {}, isPrimary: false },
  ],
};
const fields = form.fields.map(formFieldMeta);

describe('public form model (#101)', () => {
  it('builds the link', () => {
    expect(formUrl('abc', 'https://app.openrows.io')).toBe('https://app.openrows.io/f/abc');
  });

  it('prefills from the URL, numbers as typed text', () => {
    const { answers, hidden } = initialAnswers(
      form,
      '?prefill_Name=Ada&prefill_Age=7&hide_Name=true'
    );
    expect(answers).toEqual({ [NAME]: 'Ada', [AGE]: '7' });
    expect([...hidden]).toEqual([NAME]);
  });

  it('submits only shown, non-blank answers, numbers read as numbers', () => {
    const answers = { [NAME]: 'Ada', [KIND]: 'idea', [DETAILS]: 'stale', [AGE]: '42' };
    expect(submissionFields(form, answers, fields)).toEqual({
      [NAME]: 'Ada',
      [KIND]: 'idea',
      [AGE]: 42,
    });
    expect(submissionFields(form, { ...answers, [KIND]: 'bug' }, fields)).toHaveProperty(
      DETAILS,
      'stale'
    );
  });

  it('lists required shown fields without an answer', () => {
    expect(missingAnswers(form, {}, fields)).toEqual([NAME]);
    expect(missingAnswers(form, { [NAME]: 'A', [KIND]: 'bug' }, fields)).toEqual([DETAILS]);
  });

  it("reads the server's per-field messages", () => {
    const err = new ApiError(422, 'Invalid', {
      errors: [
        { path: `fields.${AGE}`, message: 'Not a valid number value.' },
        { path: 'submissionId', message: 'x' },
      ],
    });
    expect(fieldErrors(err)).toEqual({ [AGE]: 'Not a valid number value.' });
    expect(fieldErrors(new Error('x'))).toEqual({});
  });

  it('redirects only to https URLs', () => {
    const redirect = { ...form, afterSubmit: 'redirect' as const };
    expect(redirectTarget({ ...redirect, redirectUrl: 'https://example.com/thanks' })).toBe(
      'https://example.com/thanks'
    );
    expect(redirectTarget({ ...redirect, redirectUrl: 'javascript:alert(1)' })).toBeNull();
    expect(redirectTarget({ ...redirect, redirectUrl: 'http://example.com' })).toBeNull();
    expect(redirectTarget(form)).toBeNull();
  });
});

describe('linked record answers (#121)', () => {
  const a = { id: '01900000-0000-7000-8000-0000000000a1', name: 'Alpha' };
  const b = { id: '01900000-0000-7000-8000-0000000000b2', name: 'Beta' };
  it('reads picked records from whatever the answer holds', () => {
    expect(linkAnswerOf(undefined)).toEqual([]);
    expect(linkAnswerOf('Alpha')).toEqual([]);
    expect(linkAnswerOf([a, { id: b.id }, 'x', null])).toEqual([a, { id: b.id, name: '' }]);
  });
  it('adds a record once, or replaces it for a single-record link', () => {
    expect(pickLink([a], b, false)).toEqual([a, b]);
    expect(pickLink([a, b], a, false)).toEqual([a, b]);
    expect(pickLink([a], b, true)).toEqual([b]);
  });
});
