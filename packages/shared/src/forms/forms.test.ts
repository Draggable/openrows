import { describe, expect, it } from 'vitest';
import { createAttachmentSchema } from '../schemas/attachment.js';
import { updateViewSchema, viewConfigOf } from '../schemas/view.js';
import {
  type FormLayout,
  formLayoutProblems,
  formLayoutSchema,
  isFormFieldType,
  isSafeRedirectUrl,
  matchesFilter,
  pruneFormLayout,
  visibleFormFields,
} from './index.js';

const NAME = '00000000-0000-4000-8000-000000000001';
const KIND = '00000000-0000-4000-8000-000000000002';
const DETAILS = '00000000-0000-4000-8000-000000000003';
const FORMULA = '00000000-0000-4000-8000-000000000004';
const AGE = '00000000-0000-4000-8000-000000000005';
const DUE = '00000000-0000-4000-8000-000000000006';
const TAGS = '00000000-0000-4000-8000-000000000007';
const OK = '00000000-0000-4000-8000-000000000008';
const GONE = '00000000-0000-4000-8000-000000000009';

const choices = [
  { id: 'chBug', name: 'Bug', color: 'red' },
  { id: 'chIdea', name: 'Idea', color: 'green' },
];
const fields = [
  { id: NAME, type: 'singleLineText' },
  { id: KIND, type: 'singleSelect', options: { choices } },
  { id: DETAILS, type: 'longText' },
  { id: FORMULA, type: 'formula', options: { formula: '1' } },
  { id: AGE, type: 'number' },
  { id: DUE, type: 'date' },
  { id: TAGS, type: 'multipleSelect', options: { choices } },
  { id: OK, type: 'checkbox' },
];

describe('form field types (#100)', () => {
  it('takes what people type or pick and refuses computed, automatic and button fields', () => {
    for (const t of ['singleLineText', 'attachment', 'link', 'user', 'checkbox', 'rating']) {
      expect(isFormFieldType(t), t).toBe(true);
    }
    for (const t of [
      'formula',
      'lookup',
      'rollup',
      'count',
      'autoNumber',
      'createdTime',
      'lastModifiedTime',
      'createdBy',
      'lastModifiedBy',
      'button',
      'nope',
    ]) {
      expect(isFormFieldType(t), t).toBe(false);
    }
  });
});

describe('redirect URLs (#100)', () => {
  it('takes https only, spelled out, without credentials', () => {
    expect(isSafeRedirectUrl('https://example.com/thanks?x=1')).toBe(true);
    for (const bad of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,hi',
      '//example.com',
      '/thanks',
      'https://user:pw@example.com',
      'https://exa mple.com',
      `https://example.com/${'a'.repeat(2050)}`,
    ]) {
      expect(isSafeRedirectUrl(bad), bad).toBe(false);
    }
    expect(formLayoutSchema.safeParse({ redirectUrl: 'http://x.test' }).success).toBe(false);
    expect(formLayoutSchema.safeParse({ redirectUrl: '' }).success).toBe(true);
    expect(formLayoutSchema.safeParse({ redirectUrl: null }).success).toBe(true);
  });
});

describe('form layout schema (#100)', () => {
  it('is strict and capped', () => {
    expect(updateViewSchema.safeParse({ form: { fields: [{ fieldId: NAME }] } }).success).toBe(
      true
    );
    expect(updateViewSchema.safeParse({ form: { colour: 'red' } }).success).toBe(false);
    expect(formLayoutSchema.safeParse({ fields: [{ fieldId: NAME, hidden: true }] }).success).toBe(
      false
    );
    expect(formLayoutSchema.safeParse({ title: 'x'.repeat(256) }).success).toBe(false);
    expect(formLayoutSchema.safeParse({ submitLabel: 'x'.repeat(61) }).success).toBe(false);
    expect(
      formLayoutSchema.safeParse({ fields: [{ fieldId: NAME, helpText: 'x'.repeat(2001) }] })
        .success
    ).toBe(false);
    expect(
      formLayoutSchema.safeParse({
        fields: Array.from({ length: 501 }, () => ({ fieldId: NAME })),
      }).success
    ).toBe(false);
    expect(formLayoutSchema.safeParse({ afterSubmit: 'close' }).success).toBe(false);
  });
});

describe('formLayoutProblems (#100)', () => {
  it('refuses unknown, computed and repeated fields', () => {
    expect(
      formLayoutProblems(
        { fields: [{ fieldId: NAME }, { fieldId: GONE }, { fieldId: FORMULA }, { fieldId: NAME }] },
        fields
      )
    ).toEqual([
      { path: 'fields.1.fieldId', message: 'No such field in this table.' },
      {
        path: 'fields.2.fieldId',
        message: "Computed, automatic and button fields can't be on a form.",
      },
      { path: 'fields.3.fieldId', message: 'This field is already on the form.' },
    ]);
  });

  it('takes a picker view only on a link field (#121)', () => {
    const view = '01900000-0000-7000-8000-0000000000aa';
    expect(
      formLayoutProblems({ fields: [{ fieldId: NAME, viewIdForRecordSelection: view }] }, fields)
    ).toEqual([
      {
        path: 'fields.0.viewIdForRecordSelection',
        message: 'Only a linked record field picks records from a view.',
      },
    ]);
    const LINK = '01900000-0000-7000-8000-0000000000ab';
    expect(
      formLayoutProblems({ fields: [{ fieldId: LINK, viewIdForRecordSelection: view }] }, [
        ...fields,
        { id: LINK, type: 'link' },
      ])
    ).toEqual([]);
  });

  it('needs conditions on fields above the conditioned one', () => {
    const layout: FormLayout = {
      fields: [
        { fieldId: KIND },
        {
          fieldId: DETAILS,
          condition: {
            conjunction: 'and',
            conditions: [
              { fieldId: KIND, operator: 'is', value: 'chBug' },
              { fieldId: AGE, operator: '>', value: 3 },
              { conjunction: 'or', conditions: [{ fieldId: GONE, operator: 'isEmpty' }] },
            ],
          },
        },
        { fieldId: AGE },
      ],
    };
    expect(formLayoutProblems(layout, fields)).toEqual([
      {
        path: 'fields.1.condition.conditions.1.fieldId',
        message: 'A condition can only use fields above this one on the form.',
      },
      {
        path: 'fields.1.condition.conditions.2.conditions.0.fieldId',
        message: 'No such field in this table.',
      },
    ]);
  });

  it('needs a URL to redirect to', () => {
    expect(formLayoutProblems({ afterSubmit: 'redirect' }, fields)).toEqual([
      { path: 'redirectUrl', message: 'Add the https:// URL to redirect to.' },
    ]);
    expect(
      formLayoutProblems({ afterSubmit: 'redirect', redirectUrl: 'https://x.test' }, fields)
    ).toEqual([]);
  });
});

describe('pruneFormLayout (#100)', () => {
  it('drops fields that are gone or computed now, and conditions on fields not above', () => {
    const pruned = pruneFormLayout(
      {
        title: 'T',
        fields: [
          { fieldId: GONE },
          { fieldId: NAME, label: 'Your name' },
          { fieldId: FORMULA },
          {
            fieldId: DETAILS,
            condition: {
              conjunction: 'and',
              conditions: [{ fieldId: GONE, operator: 'isNotEmpty' }],
            },
          },
          {
            fieldId: AGE,
            condition: {
              conjunction: 'and',
              conditions: [
                { fieldId: NAME, operator: 'isNotEmpty' },
                { fieldId: TAGS, operator: 'isEmpty' },
              ],
            },
          },
        ],
      },
      fields
    );
    expect(pruned).toEqual({
      title: 'T',
      fields: [
        { fieldId: NAME, label: 'Your name' },
        { fieldId: DETAILS, condition: null },
        {
          fieldId: AGE,
          condition: {
            conjunction: 'and',
            conditions: [{ fieldId: NAME, operator: 'isNotEmpty' }],
          },
        },
      ],
    });
  });

  it('runs on read through viewConfigOf', () => {
    expect(
      viewConfigOf({ form: { fields: [{ fieldId: GONE }, { fieldId: NAME }] } }, fields)
    ).toEqual({ form: { fields: [{ fieldId: NAME }] } });
  });
});

describe('matchesFilter (#100)', () => {
  const is = (fieldId: string, operator: string, value?: unknown) =>
    ({
      conjunction: 'and',
      conditions: [{ fieldId, operator, ...(value === undefined ? {} : { value }) }],
    }) as Parameters<typeof matchesFilter>[0];
  const now = new Date('2026-10-26T12:00:00Z');

  it('compares text ignoring case', () => {
    expect(matchesFilter(is(NAME, 'is', 'ada'), { [NAME]: 'Ada' }, fields)).toBe(true);
    expect(matchesFilter(is(NAME, 'contains', 'D'), { [NAME]: 'Ada' }, fields)).toBe(true);
    expect(matchesFilter(is(NAME, 'doesNotContain', 'x'), {}, fields)).toBe(true);
    expect(matchesFilter(is(NAME, 'isNot', 'ada'), { [NAME]: 'Bob' }, fields)).toBe(true);
    expect(matchesFilter(is(NAME, 'isEmpty'), { [NAME]: '  ' }, fields)).toBe(true);
    expect(matchesFilter(is(NAME, 'isNotEmpty'), { [NAME]: 'x' }, fields)).toBe(true);
  });

  it('matches choices by id or name', () => {
    expect(matchesFilter(is(KIND, 'is', 'chBug'), { [KIND]: 'chBug' }, fields)).toBe(true);
    expect(matchesFilter(is(KIND, 'is', 'bug'), { [KIND]: 'chBug' }, fields)).toBe(true);
    expect(matchesFilter(is(KIND, 'is', 'chBug'), { [KIND]: 'chIdea' }, fields)).toBe(false);
    expect(matchesFilter(is(KIND, 'is', 'chBug'), {}, fields)).toBe(false);
    expect(matchesFilter(is(KIND, 'isNot', 'chBug'), {}, fields)).toBe(true);
    expect(
      matchesFilter(is(KIND, 'isAnyOf', ['chBug', 'chIdea']), { [KIND]: 'chIdea' }, fields)
    ).toBe(true);
    expect(matchesFilter(is(TAGS, 'hasAllOf', ['chBug']), { [TAGS]: ['chBug'] }, fields)).toBe(
      true
    );
    expect(
      matchesFilter(is(TAGS, 'isExactly', ['chBug']), { [TAGS]: ['chBug', 'chIdea'] }, fields)
    ).toBe(false);
    expect(matchesFilter(is(TAGS, 'hasNoneOf', ['chBug']), {}, fields)).toBe(true);
  });

  it('compares numbers, checkboxes and days', () => {
    expect(matchesFilter(is(AGE, '>', 3), { [AGE]: 4 }, fields)).toBe(true);
    expect(matchesFilter(is(AGE, '>', 3), {}, fields)).toBe(false);
    expect(matchesFilter(is(AGE, '!=', 3), {}, fields)).toBe(true);
    expect(matchesFilter(is(OK, 'is', true), { [OK]: true }, fields)).toBe(true);
    expect(matchesFilter(is(OK, 'is', false), {}, fields)).toBe(true);
    expect(matchesFilter(is(DUE, 'is', 'today'), { [DUE]: '2026-10-26' }, fields, { now })).toBe(
      true
    );
    expect(
      matchesFilter(is(DUE, 'isBefore', '2026-11-01'), { [DUE]: '2026-10-26' }, fields, { now })
    ).toBe(true);
    expect(
      matchesFilter(is(DUE, 'isWithin', 'nextWeek'), { [DUE]: '2026-10-30' }, fields, { now })
    ).toBe(true);
  });

  it('ignores blank values and unknown fields; joins with and/or and groups', () => {
    expect(matchesFilter(is(NAME, 'is', ''), {}, fields)).toBe(true);
    expect(matchesFilter(is(GONE, 'is', 'x'), {}, fields)).toBe(true);
    expect(matchesFilter(null, {}, fields)).toBe(true);
    const or = {
      conjunction: 'or' as const,
      conditions: [
        { fieldId: NAME, operator: 'is' as const, value: 'a' },
        {
          conjunction: 'and' as const,
          conditions: [
            { fieldId: AGE, operator: '>' as const, value: 1 },
            { fieldId: OK, operator: 'is' as const, value: true },
          ],
        },
      ],
    };
    expect(matchesFilter(or, { [NAME]: 'b', [AGE]: 2, [OK]: true }, fields)).toBe(true);
    expect(matchesFilter(or, { [NAME]: 'b', [AGE]: 2 }, fields)).toBe(false);
  });
});

describe('visibleFormFields (#100)', () => {
  it('shows a field when the answers above match, and hides its dependants with it', () => {
    const formFields = [
      { fieldId: KIND },
      {
        fieldId: DETAILS,
        condition: {
          conjunction: 'and' as const,
          conditions: [{ fieldId: KIND, operator: 'is' as const, value: 'chBug' }],
        },
      },
      {
        fieldId: AGE,
        condition: {
          conjunction: 'and' as const,
          conditions: [{ fieldId: DETAILS, operator: 'isNotEmpty' as const }],
        },
      },
    ];
    const ids = (values: Record<string, unknown>) =>
      visibleFormFields(formFields, values, fields).map((f) => f.fieldId);
    expect(ids({})).toEqual([KIND]);
    expect(ids({ [KIND]: 'chBug' })).toEqual([KIND, DETAILS]);
    expect(ids({ [KIND]: 'chBug', [DETAILS]: 'x' })).toEqual([KIND, DETAILS, AGE]);
    expect(ids({ [KIND]: 'chIdea', [DETAILS]: 'x' })).toEqual([KIND]);
  });
});

describe('form images (#100)', () => {
  it('names a field or a form view, and a form image is a raster image up to 10 MB', () => {
    const base = { filename: 'cover.png', type: 'image/png', size: 100 };
    expect(createAttachmentSchema.safeParse({ ...base, fieldId: NAME }).success).toBe(true);
    expect(createAttachmentSchema.safeParse({ ...base, viewId: NAME }).success).toBe(true);
    expect(createAttachmentSchema.safeParse(base).success).toBe(false);
    expect(createAttachmentSchema.safeParse({ ...base, fieldId: NAME, viewId: NAME }).success).toBe(
      false
    );
    expect(
      createAttachmentSchema.safeParse({ ...base, viewId: NAME, type: 'image/svg+xml' }).success
    ).toBe(false);
    expect(
      createAttachmentSchema.safeParse({ ...base, viewId: NAME, size: 11 * 1024 * 1024 }).success
    ).toBe(false);
  });
});
